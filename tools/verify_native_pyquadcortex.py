"""Exercise pyquadcortex over the native broker against attached hardware.

The only write changes the active scene and always attempts to restore it.
No preset, routing, parameter, global setting, or file operation is persisted.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import time


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "device-gateway" / "src"))
os.environ["QC_USE_NATIVE_BROKER"] = "1"

from qc_device_gateway.device import PyQuadCortexDevice  # noqa: E402


def wait_scene(qc, wanted: int, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if int(qc.active_scene()) == wanted:
            return True
        time.sleep(0.05)
    return int(qc.active_scene()) == wanted


def main() -> int:
    device = PyQuadCortexDevice()
    started = time.perf_counter()
    try:
        device.reconnect()
        connected_ms = round((time.perf_counter() - started) * 1000)
        snapshot_started = time.perf_counter()
        snapshot = device.snapshot()
        snapshot_ms = round((time.perf_counter() - snapshot_started) * 1000)
        qc = device._qc
        version = qc.version()
        mode = qc.mode()
        volume = qc.master_volume()
        original = int(qc.active_scene())
        target = (original + 1) % 8
        changed = restored = False
        try:
            qc.switch_scene(target)
            changed = wait_scene(qc, target)
        finally:
            qc.switch_scene(original)
            restored = wait_scene(qc, original)
        result = {
            "verified": changed and restored,
            "transport": type(qc._t).__name__,
            "connectMs": connected_ms,
            "snapshotMs": snapshot_ms,
            "preset": snapshot["presetName"],
            "blockCount": len(snapshot["blocks"]),
            "firmware": version.app_fw_version,
            "mode": int(mode.mode),
            "masterVolume": float(volume.volume),
            "presetDirty": bool(qc.preset_dirty()),
            "originalScene": original,
            "targetScene": target,
            "deviceEchoedTarget": changed,
            "restoredOriginal": restored,
        }
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["verified"] else 1
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main())
