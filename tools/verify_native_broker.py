"""Smoke-test the native broker's framed JSON-RPC contract against a QC."""

from __future__ import annotations

import base64
import json
from pathlib import Path
import struct
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
BROKER = ROOT / "services" / "device-broker" / "target" / "debug" / "qc-device-broker.exe"


def exchange(process: subprocess.Popen[bytes], request: dict) -> dict:
    body = json.dumps(request, separators=(",", ":")).encode()
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(struct.pack(">I", len(body)) + body)
    process.stdin.flush()
    length = struct.unpack(">I", process.stdout.read(4))[0]
    return json.loads(process.stdout.read(length))


def main() -> int:
    process = subprocess.Popen(
        [str(BROKER), "--stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        deadline = time.monotonic() + 35
        request_id = 0
        while True:
            request_id += 1
            response = exchange(process, {
                "jsonrpc": "2.0", "id": request_id,
                "method": "system.status", "params": {},
            })
            status = response["result"]
            if status["phase"] == "ready" or time.monotonic() >= deadline:
                break
            time.sleep(0.1)
        request_id += 1
        scene = exchange(process, {
            "jsonrpc": "2.0", "id": request_id,
            "method": "device.raw.latest", "params": {"messageType": 13},
        })["result"]
        if scene is not None:
            base64.b64decode(scene["payloadBase64"], validate=True)
        output = {
            "verified": status["phase"] == "ready" and scene is not None,
            "status": status,
            "latestSceneMessage": scene,
        }
        print(json.dumps(output, separators=(",", ":")))
        return 0 if output["verified"] else 1
    finally:
        process.terminate()
        process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
