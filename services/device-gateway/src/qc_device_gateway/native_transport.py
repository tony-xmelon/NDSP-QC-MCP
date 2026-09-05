"""pyquadcortex adapter backed by the native single-owner broker.

Rust owns HID and normalizes the realtime state stream shared with Android.
Python retains the complete pyquadcortex command/domain surface and the slower
verified snapshot path used for recovery and catalog-heavy operations.
"""

from __future__ import annotations

import base64
import gzip
import io
import itertools
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import threading
import time
from typing import Any, Callable

from .domain import IPC_MAX_FRAME_BYTES
from .usb_profile import MAX_INFLATED_BYTES


class NativeBrokerError(RuntimeError):
    """A structured error returned by the owned Rust broker."""

    def __init__(self, message: str, *, code: int = -32000, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def _read_exact(stream, length: int) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _broker_result(response: Any, request_id: int) -> Any:
    if (
        not isinstance(response, dict)
        or response.get("jsonrpc") != "2.0"
        or type(response.get("id")) is not int
        or response.get("id") != request_id
        or not set(response).issubset({"jsonrpc", "id", "result", "error"})
    ):
        raise ConnectionError("Native QC broker response did not match the request")
    has_result = "result" in response
    has_error = "error" in response
    if has_result == has_error:
        raise ConnectionError("Native QC broker response must contain exactly one result or error")
    if has_result:
        return response["result"]
    error = response["error"]
    if not isinstance(error, dict) or not set(error).issubset({"code", "message", "data"}):
        raise ConnectionError("Native QC broker returned a malformed error")
    code = error.get("code")
    message = error.get("message")
    if not isinstance(code, int) or isinstance(code, bool) or not isinstance(message, str):
        raise ConnectionError("Native QC broker returned a malformed error")
    data = error.get("data") if isinstance(error.get("data"), dict) else {}
    raw_retryable = data.get("retryable", False)
    raise NativeBrokerError(
        message,
        code=code,
        retryable=raw_retryable if isinstance(raw_retryable, bool) else False,
    )


def _gunzip_bounded(payload: bytes) -> bytes:
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as compressed:
        decoded = compressed.read(MAX_INFLATED_BYTES + 1)
    if len(decoded) > MAX_INFLATED_BYTES:
        raise ValueError("Compressed QC message exceeds the inflated-size limit")
    return decoded


def find_native_broker() -> Path | None:
    configured = os.environ.get("QC_NATIVE_BROKER_EXECUTABLE")
    if configured and Path(configured).is_file():
        return Path(configured)
    names = (
        "qc-device-broker.exe",
        "qc-device-broker-x86_64-pc-windows-msvc.exe",
        "qc-device-broker-x86_64-pc-windows-gnu.exe",
    )
    directories = [Path(sys.executable).resolve().parent]
    source = Path(__file__).resolve()
    for parent in source.parents:
        directories.extend((
            parent / "services" / "device-broker" / "target" / "release",
            parent / "services" / "device-broker" / "target" / "debug",
        ))
    for directory in directories:
        for name in names:
            candidate = directory / name
            if candidate.is_file():
                return candidate
    return None


def native_broker_enabled() -> bool:
    configured = os.environ.get("QC_USE_NATIVE_BROKER", "").strip().casefold()
    if configured in {"0", "false", "no", "off"}:
        return False
    if configured in {"1", "true", "yes", "on"}:
        return find_native_broker() is not None
    return bool(getattr(sys, "frozen", False)) and find_native_broker() is not None


class NativeBrokerRpc:
    def __init__(self, executable: Path) -> None:
        creationflags = 0x08000000 if sys.platform == "win32" else 0
        self._process = subprocess.Popen(
            [str(executable), "--stdio"], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        self._lock = threading.Lock()
        self._next_id = itertools.count(1)

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        with self._lock:
            request_id = next(self._next_id)
            body = json.dumps({
                "jsonrpc": "2.0", "id": request_id,
                "method": method, "params": params or {},
            }, separators=(",", ":")).encode()
            if len(body) > IPC_MAX_FRAME_BYTES:
                raise ValueError("Native QC broker request exceeds the IPC frame limit")
            process = self._process
            if process.poll() is not None or process.stdin is None or process.stdout is None:
                raise ConnectionError("Native QC broker is not running")
            process.stdin.write(struct.pack(">I", len(body)) + body)
            process.stdin.flush()
            header = _read_exact(process.stdout, 4)
            if len(header) != 4:
                raise ConnectionError("Native QC broker closed its response stream")
            length = struct.unpack(">I", header)[0]
            if length == 0 or length > IPC_MAX_FRAME_BYTES:
                raise ConnectionError("Native QC broker returned an invalid frame")
            payload = _read_exact(process.stdout, length)
            if len(payload) != length:
                raise ConnectionError("Native QC broker returned an incomplete frame")
            try:
                response = json.loads(payload)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise ConnectionError("Native QC broker returned invalid JSON") from error
            return _broker_result(response, request_id)

    def wait_ready(self, timeout: float = 35.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            # system.status is the public gateway capability document. The
            # source-only Python parity oracle polls the broker's device state.
            status = self.call("device.status")
            if status["phase"] == "ready":
                return status
            if time.monotonic() >= deadline:
                raise TimeoutError(status.get("detail", "Native QC broker did not become ready"))
            time.sleep(0.1)

    def close(self) -> None:
        process = self._process
        if process is not None and process.poll() is None:
            try:
                self.call("device.disconnect")
            except Exception:
                pass
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
        self._process = None  # type: ignore[assignment]


class NativeBrokerTransport:
    """The five-method transport contract consumed by pyquadcortex.QuadCortex."""

    def __init__(self, rpc: NativeBrokerRpc) -> None:
        self._rpc = rpc
        self._ids = itertools.count(100_000)

    @staticmethod
    def _registry():
        import pyquadcortex

        protocol = getattr(pyquadcortex, "protocol", pyquadcortex)
        return __import__(f"{protocol.__name__}.registry", fromlist=["registry"])

    @staticmethod
    def _decode(raw: dict[str, Any]):
        registry = NativeBrokerTransport._registry()
        message = registry.class_for(int(raw["messageType"]))()
        payload = base64.b64decode(raw["payloadBase64"], validate=True)
        if payload.startswith(b"\x1f\x8b"):
            payload = _gunzip_bounded(payload)
        message.ParseFromString(payload)
        return message

    @staticmethod
    def _encoded(message) -> tuple[int, str]:
        registry = NativeBrokerTransport._registry()
        return registry.type_for(type(message)), base64.b64encode(message.SerializeToString()).decode()

    def next_request_id(self) -> int:
        return next(self._ids)

    def gateway_request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Invoke a typed public gateway method through the owned Rust broker."""
        return self._rpc.call(method, params or {})

    def send(self, message) -> None:
        message_type, payload = self._encoded(message)
        self._rpc.call("device.raw.send", {"messageType": message_type, "payloadBase64": payload})

    def request(self, message, timeout: float = 5.0):
        request_id = self.next_request_id()
        message.request_id = request_id
        message_type, payload = self._encoded(message)
        raw = self._rpc.call("device.raw.request", {
            "messageType": message_type, "expectedType": message_type,
            "requestId": request_id, "timeoutMs": round(timeout * 1000),
            "payloadBase64": payload,
        })
        return self._decode(raw)

    def _cursor(self) -> int:
        events = self._rpc.call("device.raw.events", {"afterSequence": 0, "limit": 4096})
        return max((int(item["sequence"]) for item in events), default=0)

    def _events(self, after: int, expected_class) -> list[tuple[int, Any]]:
        message_type = self._registry().type_for(expected_class)
        raw = self._rpc.call("device.raw.events", {
            "afterSequence": after, "messageType": message_type, "limit": 4096,
        })
        return [(int(item["sequence"]), self._decode(item)) for item in raw]

    def tempo_clock(self) -> dict[str, Any] | None:
        """Return the newest hardware metronome edge without reading the preset."""
        raw = self._rpc.call("device.raw.latest", {"messageType": 33})
        if raw is None:
            return None
        message = self._decode(raw)
        if not message.HasField("metronome_status"):
            return None
        status = message.metronome_status
        return {
            "sequence": int(raw["sequence"]),
            "receivedAtUnixMs": int(raw["receivedAtUnixMs"]),
            "currentBeat": int(status.current_beat),
            "currentBar": int(status.current_bar),
            "currentTick": int(status.current_tick),
        }

    def state_events(self, after_sequence: int = 0, limit: int = 256) -> list[dict[str, Any]]:
        """Return state already normalized by the shared native Rust engine."""
        return self._rpc.call("device.state.events", {
            "afterSequence": max(0, int(after_sequence)),
            "limit": max(1, min(4096, int(limit))),
        })

    def block_details(self, row: int, column: int, expected_preset_name: str = "") -> dict[str, Any] | None:
        """Read the shared Rust decoder's current block/editor projection."""
        status = self._rpc.call("device.status")
        actual_name = str(status.get("activePresetName") or "")
        placeholder = expected_preset_name.casefold() in {"current preset", "empty preset", "unsaved"}
        if expected_preset_name and actual_name != expected_preset_name and not (not actual_name and placeholder):
            raise RuntimeError(
                f"Preset changed on the Quad Cortex: expected {expected_preset_name!r}, "
                f"but {actual_name or 'an unnamed preset'!r} is active. Refresh and retry."
            )
        return self._rpc.call("device.state.blockDetails", {"row": int(row), "column": int(column)})

    def lane_control_details(self, row: int, control: str, expected_preset_name: str = "") -> dict[str, Any]:
        return self._rpc.call("device.laneControlDetails", {
            "row": int(row), "control": str(control),
            "expectedPresetName": str(expected_preset_name),
        })

    def preview_lane_control_parameter(self, **params: Any) -> dict[str, Any]:
        return self._rpc.call("device.previewLaneControlParameter", params)

    def set_lane_control_parameter(self, **params: Any) -> dict[str, Any]:
        return self._rpc.call("device.setLaneControlParameter", params)

    def set_lane_control_scene_mode(self, **params: Any) -> dict[str, Any]:
        return self._rpc.call("device.setLaneControlSceneMode", params)

    def select_scene(self, scene: int) -> None:
        self._rpc.call("device.command.scene", {"scene": int(scene)})

    def set_bypass(self, row: int, column: int, bypassed: bool) -> None:
        self._rpc.call("device.command.bypass", {
            "row": int(row), "column": int(column), "bypassed": bool(bypassed),
        })

    def set_parameter(self, row: int, column: int, parameter_index: int, *, value=None, text=None) -> None:
        params = {"row": int(row), "column": int(column), "parameterIndex": int(parameter_index)}
        if text is not None:
            params["text"] = str(text)
        else:
            params["value"] = float(value)
        self._rpc.call("device.command.parameter", params)

    def set_tempo(self, bpm: int) -> None:
        self._rpc.call("device.command.tempo", {"bpm": int(bpm)})

    def _operation(self, operation: str, **params: Any) -> None:
        self._rpc.call("device.command.operation", {"operation": operation, **params})

    def set_block(self, row: int, column: int, model_id: int) -> None:
        self._operation("addBlock", row=int(row), column=int(column), modelId=int(model_id))

    def remove_block(self, row: int, column: int) -> None:
        self._operation("removeBlock", row=int(row), column=int(column))

    def move_block(self, from_row: int, from_column: int, to_row: int, to_column: int) -> None:
        self._operation(
            "moveBlock", row=int(from_row), fromColumn=int(from_column),
            toRow=int(to_row), toColumn=int(to_column),
        )

    def set_footswitch(self, row: int, column: int, footswitch: int | None) -> None:
        self._operation("setFootswitch", row=int(row), column=int(column), footswitch=footswitch)

    def set_chain_input(self, row: int, input_id: int) -> None:
        self._operation("setChainInput", row=int(row), inputId=int(input_id))

    def set_chain_output(self, row: int, output_id: int) -> None:
        self._operation("setChainOutput", row=int(row), outputId=int(output_id))

    def set_chain_split(self, row: int, split_column: int | None, mix_column: int | None) -> None:
        self._operation(
            "setChainSplit", row=int(row), splitColumn=split_column, mixColumn=mix_column,
        )

    def set_split_mute(self, row: int, muted: bool) -> None:
        self._operation("setSplitMute", row=int(row), muted=bool(muted))

    def set_routing_parameter(self, row: int, node: str, parameter_index: int, value: float) -> None:
        self._operation(
            "setRoutingParameter", row=int(row), node=str(node),
            parameterIndex=int(parameter_index), value=float(value),
        )

    def list_preset_folders(self) -> None:
        self._operation("listPresetFolders")

    def save_preset(self, setlist_key: str, position: int, name: str, instrument: int = 0) -> None:
        self._operation(
            "savePreset", setlistKey=str(setlist_key), position=int(position),
            name=str(name), instrument=int(instrument),
        )

    def await_broadcast(self, expected_class, trigger: Callable[[], Any], timeout: float = 40.0, match=None):
        cursor = self._cursor()
        trigger()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for sequence, message in self._events(cursor, expected_class):
                cursor = max(cursor, sequence)
                if match is None or match(message):
                    return message
            time.sleep(0.01)
        raise TimeoutError(f"no {expected_class.__name__} broadcast within {timeout}s")

    def collect(self, expected_class, trigger: Callable[[], Any], seconds: float, match=None):
        cursor = self._cursor()
        trigger()
        deadline = time.monotonic() + seconds
        collected = []
        while time.monotonic() < deadline:
            for sequence, message in self._events(cursor, expected_class):
                cursor = max(cursor, sequence)
                if match is None or match(message):
                    collected.append(message)
            time.sleep(0.02)
        return collected

    def stop(self, join_timeout: float = 1.0) -> None:
        del join_timeout
        self._rpc.close()


def connect_native():
    """Return a high-level pyquadcortex client using the native USB owner."""
    import pyquadcortex

    protocol = getattr(pyquadcortex, "protocol", pyquadcortex)
    QuadCortex = protocol.QuadCortex

    executable = find_native_broker()
    if executable is None:
        raise FileNotFoundError("The native QC broker executable was not found")
    rpc = NativeBrokerRpc(executable)
    try:
        rpc.wait_ready()
        transport = NativeBrokerTransport(rpc)
        return QuadCortex(transport, _owned_resources=[transport.stop])
    except BaseException:
        rpc.close()
        raise
