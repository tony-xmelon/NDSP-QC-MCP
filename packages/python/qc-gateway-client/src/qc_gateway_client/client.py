"""Clients for the private QC Gateway JSON-RPC v1 transport."""

from __future__ import annotations

import json
import shlex
import struct
import subprocess
import threading
from collections.abc import Mapping, Sequence
from typing import Any, BinaryIO, Protocol

from .generated_domain import IPC_MAX_FRAME_BYTES
from .generated_gateway_methods import GATEWAY_METHODS

GATEWAY_PROTOCOL = "gateway.v1"


class GatewayError(RuntimeError):
    """A stable, sanitized error returned by or raised while calling the gateway."""

    def __init__(self, message: str, *, code: int = -32000) -> None:
        super().__init__(message)
        self.code = code


class GatewayHandler(Protocol):
    def handle(self, request: dict[str, Any]) -> dict[str, Any]: ...


def _read_frame(stream: BinaryIO) -> dict[str, Any]:
    header = stream.read(4)
    if len(header) != 4:
        raise GatewayError("The QC Gateway closed its response stream.")
    (length,) = struct.unpack(">I", header)
    if length == 0 or length > IPC_MAX_FRAME_BYTES:
        raise GatewayError("The QC Gateway returned an invalid frame length.")
    payload = stream.read(length)
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
        if response.get("id") != request_id or response.get("jsonrpc") != "2.0":
            raise GatewayError("The QC Gateway response did not match the request.")
        error = response.get("error")
        if isinstance(error, dict):
            raise GatewayError(str(error.get("message", "QC Gateway request failed.")), code=int(error.get("code", -32000)))
        if "result" not in response:
            raise GatewayError("The QC Gateway response did not contain a result.")
        return response["result"]


class StdioGatewayClient(_RequestMixin):
    """Own a gateway child process and call its framed stdio contract."""

    def __init__(self, command: Sequence[str]) -> None:
        if not command:
            raise ValueError("A gateway command is required.")
        self.command = tuple(command)
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
            return _read_frame(process.stdout)
        except (BrokenPipeError, OSError) as exc:
            raise GatewayError("Communication with the QC Gateway failed.") from exc

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
