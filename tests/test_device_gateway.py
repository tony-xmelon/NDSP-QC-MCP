from __future__ import annotations

import io
from pathlib import Path
import subprocess
import struct
import sys
import unittest

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "services" / "device-gateway" / "src"))

from qc_device_gateway.framing import FramingError, read_frame, write_frame
from qc_device_gateway.service import GatewayService


class FakeDevice:
    def __init__(self):
        self.closed = False

    def close(self): self.closed = True
    def reconnect(self): return {"phase": "ready", "detail": "fake ready", "demo": False}
    def reset_session(self): return self.reconnect()
    def snapshot(self): return {"presetName": "Test", "blocks": []}
    def select_scene(self, scene, expected_preset_name=""):
        return {"detail": f"scene {scene}", "snapshot": self.snapshot()}
    def toggle_bypass(self, row, column, expected_scene, expected_preset_name=""):
        return {"detail": f"bypass {row}:{column}:{expected_scene}", "snapshot": self.snapshot()}
    def show_tuner(self, shown=True): return {"detail": f"tuner {shown}"}
    def show_gig_view(self, shown=True): return {"detail": f"gig {shown}"}


class FramingTests(unittest.TestCase):
    def test_round_trip(self):
        stream = io.BytesIO()
        message = {"jsonrpc": "2.0", "id": 1, "method": "system.status"}
        write_frame(stream, message)
        stream.seek(0)
        self.assertEqual(read_frame(stream), message)

    def test_rejects_truncated_payload(self):
        with self.assertRaises(FramingError):
            read_frame(io.BytesIO(struct.pack(">I", 8) + b"{}"))


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.service = GatewayService(FakeDevice())

    def request(self, method, params=None):
        return self.service.handle({"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}})

    def test_status_is_available_and_persistent_writes_are_locked(self):
        result = self.request("system.status")["result"]
        self.assertTrue(result["gatewayAvailable"])
        self.assertIn("persistent writes remain locked", result["message"])

    def test_reconnect_and_snapshot(self):
        self.assertEqual(self.request("device.reconnect")["result"]["phase"], "ready")
        self.assertEqual(self.request("device.snapshot")["result"]["presetName"], "Test")

    def test_unknown_method_uses_json_rpc_error(self):
        self.assertEqual(self.request("device.mutate")["error"]["code"], -32601)

    def test_boolean_request_id_is_rejected(self):
        response = self.service.handle({"jsonrpc": "2.0", "id": True, "method": "system.status"})
        self.assertEqual(response["error"]["code"], -32600)

    def test_live_control_methods_are_dispatched_with_params(self):
        scene = self.request("device.selectScene", {"scene": 3, "expectedPresetName": "Test"})
        bypass = self.request("device.toggleBypass", {
            "row": 2, "column": 4, "expectedScene": 3, "expectedPresetName": "Test"
        })
        tuner = self.request("device.showTuner", {"shown": True})
        gig = self.request("device.showGigView", {"shown": True})
        self.assertEqual(scene["result"]["detail"], "scene 3")
        self.assertEqual(bypass["result"]["detail"], "bypass 2:4:3")
        self.assertEqual(tuner["result"]["detail"], "tuner True")
        self.assertEqual(gig["result"]["detail"], "gig True")


class ProcessTests(unittest.TestCase):
    def test_stdio_process_answers_status(self):
        with subprocess.Popen(
            [sys.executable, str(ROOT / "services" / "device-gateway" / "main.py"), "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        ) as process:
            assert process.stdin is not None
            assert process.stdout is not None
            write_frame(process.stdin, {"jsonrpc": "2.0", "id": 1, "method": "system.status", "params": {}})
            response = read_frame(process.stdout)
            self.assertIsNotNone(response)
            self.assertTrue(response["result"]["gatewayAvailable"])
            process.stdin.close()
            self.assertEqual(process.wait(timeout=5), 0)


if __name__ == "__main__":
    unittest.main()
