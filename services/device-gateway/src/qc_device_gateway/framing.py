"""Length-prefixed JSON framing for the gateway's private stdio channel."""

from __future__ import annotations

import json
import struct
from typing import Any, BinaryIO

MAX_FRAME_BYTES = 16 * 1024 * 1024


class FramingError(ValueError):
    pass


def read_frame(stream: BinaryIO) -> dict[str, Any] | None:
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise FramingError("incomplete frame header")
    (length,) = struct.unpack(">I", header)
    if length == 0 or length > MAX_FRAME_BYTES:
        raise FramingError(f"invalid frame length: {length}")
    payload = stream.read(length)
    if len(payload) != length:
        raise FramingError("incomplete frame payload")
    try:
        message = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise FramingError(f"invalid JSON payload: {exc}") from exc
    if not isinstance(message, dict):
        raise FramingError("JSON-RPC frame must contain an object")
    return message


def write_frame(stream: BinaryIO, message: dict[str, Any]) -> None:
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    if len(payload) > MAX_FRAME_BYTES:
        raise FramingError("frame exceeds maximum size")
    stream.write(struct.pack(">I", len(payload)))
    stream.write(payload)
    stream.flush()
