"""Repeat the Rust broker's LocalBackup transfer without printing its contents."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
BROKER = Path(
    os.environ.get(
        "QC_NATIVE_BACKUP_BROKER",
        ROOT / "services" / "device-broker" / "target" / "debug" / "qc-device-broker.exe",
    )
)


def exchange(process: subprocess.Popen[bytes], request: dict) -> dict:
    body = json.dumps(request, separators=(",", ":")).encode()
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(struct.pack(">I", len(body)) + body)
    process.stdin.flush()
    while True:
        header = process.stdout.read(4)
        if len(header) != 4:
            stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
            raise RuntimeError(f"broker exited before replying: {stderr.strip()}")
        length = struct.unpack(">I", header)[0]
        response = json.loads(process.stdout.read(length))
        if response.get("id") == request["id"]:
            if "error" in response:
                raise RuntimeError(response["error"].get("message", str(response["error"])))
            return response["result"]


def main() -> int:
    arguments = sys.argv[1:]
    runs = next((int(argument) for argument in arguments if argument.isdigit()), 1)
    reset_session = "--reset-session" in arguments
    disconnect_reconnect = "--disconnect-reconnect" in arguments
    device_name_roundtrip = "--device-name-roundtrip" in arguments
    screen_tap_roundtrip = "--screen-tap-roundtrip" in arguments
    expected_suffix = os.environ.get("QC_EXPECTED_SERIAL_SUFFIX")
    if not expected_suffix:
        raise RuntimeError("QC_EXPECTED_SERIAL_SUFFIX is required for the physical safety check")

    flight_path = ROOT / "tmp" / "native-backup-flight.json"
    flight_path.unlink(missing_ok=True)
    child_environment = os.environ.copy()
    child_environment["QC_FLIGHT_RECORDER_PATH"] = str(flight_path)
    process = subprocess.Popen(
        [str(BROKER), "--stdio"],
        cwd=ROOT,
        env=child_environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    request_id = 1
    results = []
    disconnected = False
    try:
        status = exchange(
            process,
            {"jsonrpc": "2.0", "id": request_id, "method": "device.reconnect", "params": {}},
        )
        request_id += 1
        identity = exchange(
            process,
            {"jsonrpc": "2.0", "id": request_id, "method": "device.identity", "params": {}},
        )
        request_id += 1
        if not identity.get("serial", "").endswith(expected_suffix):
            raise RuntimeError("connected QC does not match QC_EXPECTED_SERIAL_SUFFIX")

        if device_name_roundtrip:
            original_name = (identity.get("customName") or "Quad Cortex").strip()
            temporary_name = "QC MCP BACKUP TEST"
            if original_name == temporary_name:
                temporary_name = "QC MCP BACKUP TEST 2"
            for name in (temporary_name, original_name):
                exchange(
                    process,
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": "device.setDeviceName",
                        "params": {"name": name, "confirmPersistentWrite": True},
                    },
                )
                request_id += 1

        if reset_session:
            reset = exchange(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "device.resetSession",
                    "params": {"confirmRiskyOperation": True},
                },
            )
            request_id += 1
            if reset.get("phase") != "ready":
                raise RuntimeError(f"session reset ended in {reset.get('phase')!r}")

        if disconnect_reconnect:
            exchange(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "device.disconnect",
                    "params": {"confirmRiskyOperation": True},
                },
            )
            request_id += 1
            reconnect = exchange(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "device.reconnect",
                    "params": {"confirmRiskyOperation": True},
                },
            )
            request_id += 1
            if reconnect.get("phase") != "ready":
                raise RuntimeError(f"reconnect ended in {reconnect.get('phase')!r}")

        if screen_tap_roundtrip:
            for _ in range(2):
                exchange(
                    process,
                    {
                        "jsonrpc": "2.0",
                        "id": request_id,
                        "method": "device.tapScreen",
                        "params": {
                            "x": 400,
                            "y": 240,
                            "confirmRiskyOperation": True,
                        },
                    },
                )
                request_id += 1
        for index in range(runs):
            started = time.monotonic()
            backup = exchange(
                process,
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": "device.createBackup",
                    "params": {"name": "Rust transport verification"},
                },
            )
            request_id += 1
            encoded = json.dumps(backup, separators=(",", ":"), ensure_ascii=False).encode()
            if backup.get("type") != "backup" or backup.get("creator") != "quad":
                raise RuntimeError(f"run {index + 1} returned an unsupported backup wrapper")
            after = exchange(
                process,
                {"jsonrpc": "2.0", "id": request_id, "method": "device.status", "params": {}},
            )
            request_id += 1
            if after.get("phase") != "ready":
                raise RuntimeError(f"run {index + 1} left the broker in {after.get('phase')!r}")
            results.append(
                {
                    "run": index + 1,
                    "seconds": round(time.monotonic() - started, 3),
                    "bytes": len(encoded),
                    "sha256": hashlib.sha256(encoded).hexdigest(),
                    "sessionReady": True,
                }
            )
        exchange(
            process,
            {"jsonrpc": "2.0", "id": request_id, "method": "device.disconnect", "params": {}},
        )
        request_id += 1
        disconnected = True
        flight = json.loads(flight_path.read_text(encoding="utf-8"))
        backup_frames = [
            entry
            for entry in flight.get("entries", [])
            if entry.get("event") == "inbound" and entry.get("messageType") == 40
        ]
        if len(backup_frames) < runs * 12:
            raise RuntimeError(
                f"flight recorder contains {len(backup_frames)} backup frames; expected at least {runs * 12}"
            )
        print(
            json.dumps(
                {
                    "verified": True,
                    "broker": str(BROKER),
                    "runs": results,
                    "backupFrames": len(backup_frames),
                    "minReportsPerChunk": min(entry["reportCount"] for entry in backup_frames),
                    "maxReportsPerChunk": max(entry["reportCount"] for entry in backup_frames),
                },
                separators=(",", ":"),
            )
        )
        return 0
    finally:
        if not disconnected:
            try:
                exchange(
                    process,
                    {"jsonrpc": "2.0", "id": request_id, "method": "device.disconnect", "params": {}},
                )
            except (BrokenPipeError, EOFError, OSError, RuntimeError, TypeError):
                pass
        process.terminate()
        process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
