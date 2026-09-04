"""Smoke-test the native broker's framed JSON-RPC contract against a QC."""

from __future__ import annotations

import base64
import json
from pathlib import Path
import struct
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
BROKER = ROOT / "services" / "device-broker" / "target" / "debug" / "qc-device-broker.exe"


def exchange(process: subprocess.Popen[bytes], request: dict) -> dict:
    body = json.dumps(request, separators=(",", ":")).encode()
    assert process.stdin is not None and process.stdout is not None
    process.stdin.write(struct.pack(">I", len(body)) + body)
    process.stdin.flush()
    while True:
        length = struct.unpack(">I", process.stdout.read(4))[0]
        response = json.loads(process.stdout.read(length))
        # Live state notifications share stdout with replies and commonly arrive
        # while reconnect is still waiting for the initial preset.
        if response.get("id") == request["id"]:
            return response


def main() -> int:
    process = subprocess.Popen(
        [str(BROKER), "--stdio"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        request_id = 1
        response = exchange(process, {
            "jsonrpc": "2.0", "id": request_id,
            "method": "device.reconnect", "params": {},
        })
        if "error" in response:
            raise RuntimeError(response["error"].get("message", "device.reconnect failed"))
        status = response["result"]
        request_id += 1
        scene = exchange(process, {
            "jsonrpc": "2.0", "id": request_id,
            "method": "device.raw.latest", "params": {"messageType": 13},
        })["result"]
        if scene is not None:
            base64.b64decode(scene["payloadBase64"], validate=True)
        request_id += 1
        screen = exchange(process, {
            "jsonrpc": "2.0", "id": request_id,
            "method": "device.captureScreen", "params": {},
        })["result"]
        screen_png = base64.b64decode(screen["pngBase64"], validate=True)
        screen_verified = (
            screen.get("width") == 800
            and screen.get("height") == 480
            and screen_png.startswith(b"\x89PNG\r\n\x1a\n")
        )
        output = {
            "verified": status["phase"] == "ready" and scene is not None and screen_verified,
            "status": status,
            "latestSceneMessage": scene,
            "screen": {"width": screen.get("width"), "height": screen.get("height")},
        }
        print(json.dumps(output, separators=(",", ":")))
        return 0 if output["verified"] else 1
    finally:
        try:
            request_id += 1
            exchange(process, {
                "jsonrpc": "2.0", "id": request_id,
                "method": "device.disconnect", "params": {},
            })
        except (BrokenPipeError, EOFError, OSError, TypeError):
            pass
        process.terminate()
        process.wait(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
