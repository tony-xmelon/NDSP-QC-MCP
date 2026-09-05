"""Clients for the private QC Gateway JSON-RPC v1 transport."""

from __future__ import annotations

import json
import queue
import shlex
import struct
import subprocess
import threading
from collections.abc import Mapping, Sequence
from typing import Any, BinaryIO, Protocol

from .generated_domain import IPC_MAX_FRAME_BYTES
from .generated_gateway_methods import GATEWAY_METHODS, GATEWAY_RESULT_KINDS

GATEWAY_PROTOCOL = "gateway.v1"


class GatewayError(RuntimeError):
    """A stable, sanitized error returned by or raised while calling the gateway."""

    def __init__(self, message: str, *, code: int = -32000, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class GatewayHandler(Protocol):
    def handle(self, request: dict[str, Any]) -> dict[str, Any]: ...


def _read_frame(stream: BinaryIO) -> dict[str, Any]:
    def read_exact(length: int) -> bytes:
        chunks: list[bytes] = []
        remaining = length
        while remaining:
            chunk = stream.read(remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    header = read_exact(4)
    if len(header) != 4:
        raise GatewayError("The QC Gateway closed its response stream.")
    (length,) = struct.unpack(">I", header)
    if length == 0 or length > IPC_MAX_FRAME_BYTES:
        raise GatewayError("The QC Gateway returned an invalid frame length.")
    payload = read_exact(length)
    if len(payload) != length:
        raise GatewayError("The QC Gateway returned an incomplete response.")
    try:
        result = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GatewayError("The QC Gateway returned invalid JSON.") from exc
    if not isinstance(result, dict):
        raise GatewayError("The QC Gateway response was not an object.")
    return result


def _write_frame(stream: BinaryIO, message: Mapping[str, Any]) -> None:
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > IPC_MAX_FRAME_BYTES:
        raise GatewayError("The QC Gateway request is too large.")
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()


class _RequestMixin:
    _next_id: int
    _lock: threading.Lock

    def _exchange(self, request: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError

    def request(self, method: str, params: Mapping[str, Any] | None = None) -> Any:
        if method not in GATEWAY_METHODS:
            raise ValueError("Only versioned QC Gateway methods are accepted.")
        with self._lock:
            request_id = self._next_id
            self._next_id += 1
            response = self._exchange({
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": dict(params or {}),
            })
        response_id = response.get("id")
        if (
            type(response_id) is not int
            or response_id != request_id
            or response.get("jsonrpc") != "2.0"
            or not set(response).issubset({"jsonrpc", "id", "result", "error"})
        ):
            raise GatewayError("The QC Gateway response did not match the request.")
        has_error = "error" in response
        has_result = "result" in response
        if has_error == has_result:
            raise GatewayError("The QC Gateway response must contain exactly one result or error.")
        if has_error:
            error = response["error"]
            if not isinstance(error, dict) or not set(error).issubset({"code", "message", "data"}):
                raise GatewayError("The QC Gateway returned a malformed error.")
            data = error.get("data") if isinstance(error.get("data"), dict) else {}
            raw_code = error.get("code", -32000)
            code = raw_code if isinstance(raw_code, int) and not isinstance(raw_code, bool) else -32000
            message = error.get("message")
            if not isinstance(message, str):
                raise GatewayError("The QC Gateway returned a malformed error.", code=code)
            raw_retryable = data.get("retryable", False)
            retryable = raw_retryable if isinstance(raw_retryable, bool) else False
            raise GatewayError(
                message,
                code=code,
                retryable=retryable,
            )
        result = response["result"]
        if not isinstance(result, dict):
            raise GatewayError(f"{method} returned a malformed {GATEWAY_RESULT_KINDS[method]} result.")
        kind = GATEWAY_RESULT_KINDS[method]
        if kind == "PresetSnapshot" and (
            not isinstance(result.get("presetName"), str) or not isinstance(result.get("blocks"), list)
        ):
            raise GatewayError(f"{method} returned a malformed PresetSnapshot result.")
        markers = ("accepted", "verified", "verification")
        has_outcome = any(marker in result for marker in markers)
        if kind == "DeviceActionResult" and not has_outcome:
            raise GatewayError(f"{method} returned a device action result without verification semantics.")
        if has_outcome:
            verified = result.get("verified")
            expected = "authoritative_readback" if verified is True else "accepted_unverified"
            if (
                result.get("accepted") is not True
                or not isinstance(verified, bool)
                or result.get("verification") != expected
                or not isinstance(result.get("detail"), str)
                or len(result["detail"]) > 4096
            ):
                raise GatewayError(f"{method} returned a malformed device action result.")
        return result


class StdioGatewayClient(_RequestMixin):
    """Own a gateway child process and call its framed stdio contract."""

    def __init__(self, command: Sequence[str], *, response_timeout: float = 300.0) -> None:
        if not command:
            raise ValueError("A gateway command is required.")
        if response_timeout <= 0:
            raise ValueError("The gateway response timeout must be positive.")
        self.command = tuple(command)
        self.response_timeout = response_timeout
        self._next_id = 1
        self._lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None

    @classmethod
    def from_command_line(cls, command: str) -> "StdioGatewayClient":
        # posix=False preserves Windows backslashes but also preserves a token's
        # surrounding quotes. Popen(sequence) needs those quotes removed.
        tokens = shlex.split(command, posix=False)
        normalized = [
            token[1:-1] if len(token) >= 2 and token[0] == token[-1] and token[0] in "\"'" else token
            for token in tokens
        ]
        return cls(normalized)

    def _start(self) -> subprocess.Popen[bytes]:
        process = self._process
        if process is None or process.poll() is not None:
            process = subprocess.Popen(
                self.command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
            )
            self._process = process
        return process

    def _exchange(self, request: dict[str, Any]) -> dict[str, Any]:
        process = self._start()
        if process.stdin is None or process.stdout is None:
            raise GatewayError("The QC Gateway stdio transport is unavailable.")
        try:
            _write_frame(process.stdin, request)
            result: queue.Queue[dict[str, Any] | Exception] = queue.Queue(maxsize=1)

            def read_response() -> None:
                try:
                    result.put_nowait(_read_frame(process.stdout))
                except Exception as exc:  # transported back to the caller thread
                    result.put_nowait(exc)

            reader = threading.Thread(
                target=read_response,
                name="qc-gateway-response",
                daemon=True,
            )
            reader.start()
            try:
                outcome = result.get(timeout=self.response_timeout)
            except queue.Empty as exc:
                # Closing the process also closes stdout and releases the daemon
                # reader. Never reuse a stream after a timed-out request because
                # its eventual response could be mistaken for the next call.
                if self._process is process:
                    self._process = None
                process.kill()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    pass
                raise GatewayError(
                    f"The QC Gateway did not respond within {self.response_timeout:g} seconds.",
                    retryable=True,
                ) from exc
            if isinstance(outcome, Exception):
                raise outcome
            return outcome
        except (BrokenPipeError, OSError) as exc:
            if self._process is process:
                self._process = None
            raise GatewayError(
                "Communication with the QC Gateway failed.", retryable=True
            ) from exc

    def close(self) -> None:
        process = self._process
        self._process = None
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()


class InProcessGatewayClient(_RequestMixin):
    """Use a gateway service in-process for direct USB ownership and tests."""

    def __init__(self, service: GatewayHandler) -> None:
        self.service = service
        self._next_id = 1
        self._lock = threading.Lock()

    def _exchange(self, request: dict[str, Any]) -> dict[str, Any]:
        return self.service.handle(request)

    def close(self) -> None:
        close = getattr(self.service, "close", None)
        if callable(close):
            close()
