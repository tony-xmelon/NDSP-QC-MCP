"""Summarize a local Cortex Control HID trace without dumping private values."""

from __future__ import annotations

import argparse
import hashlib
from collections import Counter
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from google.protobuf.message import DecodeError
from pyquadcortex import framing, registry
from pyquadcortex.proto import ProductionAutomation_pb2 as pa


REPORT_BYTES = 129
PRIVATE_KEYS = {"author_id", "author_username", "token", "access_token", "email"}


def clean(value):
    if isinstance(value, dict):
        return {
            key: "<redacted>" if key.casefold() in PRIVATE_KEYS else clean(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, str) and len(value) > 256:
        return {
            "chars": len(value),
            "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
            "prefix": value[:64],
        }
    return value


def messages_from(data: bytes):
    pending: list[bytes] = []
    for offset in range(0, len(data) - (len(data) % REPORT_BYTES), REPORT_BYTES):
        report = data[offset : offset + REPORT_BYTES]
        if report[2] & framing.FLAG_FIRST:
            pending = []
        pending.append(report)
        if framing.is_complete(pending):
            yield framing.decode_reports(pending)
            pending = []


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("trace", type=Path)
    args = parser.parse_args()
    summaries = []
    counts: Counter[str] = Counter()
    for index, (message_type, payload) in enumerate(messages_from(args.trace.read_bytes())):
        try:
            name = pa.CortexMessageType.Enum.Name(message_type)
        except ValueError:
            name = f"Unknown({message_type})"
        counts[name] += 1
        entry = {"index": index, "type": name, "payload_bytes": len(payload)}
        try:
            message = registry.class_for(message_type)()
            message.ParseFromString(payload)
            entry["message"] = clean(
                MessageToDict(message, preserving_proto_field_name=True)
            )
        except (KeyError, ValueError, DecodeError) as error:
            entry["decode_error"] = str(error)
            entry["payload_hex"] = payload.hex()
        if name != "KeepAlive":
            summaries.append(entry)
    print({"counts": dict(counts), "messages": summaries})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
