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
    def disconnect(self): return {"phase": "disconnected", "detail": "fake closed", "demo": True}
    def snapshot(self): return {"presetName": "Test", "blocks": []}
    def select_scene(self, scene, expected_preset_name=""):
        return {"detail": f"scene {scene}", "snapshot": self.snapshot()}
    def toggle_bypass(self, row, column, expected_scene, expected_bypassed, desired_bypassed, expected_preset_name=""):
        return {"detail": f"bypass {row}:{column}:{expected_scene}:{expected_bypassed}:{desired_bypassed}", "snapshot": self.snapshot()}
    def list_presets(self, refresh=False):
        return {"setlistKey": "fake", "setlistName": "Fake", "currentPosition": 9, "presets": []}
    def navigate_bank(self, direction, expected_preset_name, expected_position):
        return {"detail": f"bank {direction}:{expected_position}", "snapshot": self.snapshot()}
    def recall_preset(self, setlist_key, position, expected_preset_name, expected_position):
        return {"detail": f"recall {setlist_key}:{position}", "snapshot": self.snapshot()}
    def reload_preset(self, expected_preset_name, expected_position):
        return {"detail": f"reload {expected_position}", "snapshot": self.snapshot()}
    def block_details(self, row, column, expected_preset_name=""):
        return {"row": row, "column": column, "name": "Fake block", "parameters": []}
    def set_parameter(self, row, column, parameter_index, value, expected_value, expected_scene, expected_preset_name):
        return {"detail": f"parameter {parameter_index}:{value}", "block": self.block_details(row, column), "snapshot": self.snapshot()}
    def set_tempo(self, bpm, expected_tempo, expected_preset_name):
        return {"detail": f"tempo {bpm}:{expected_tempo}", "snapshot": self.snapshot()}
    def press_footswitch(self, index, expected_mode, expected_preset_name):
        return {"detail": f"footswitch {index}:{expected_mode}", "snapshot": self.snapshot()}
    def list_preset_slots(self):
        return {"setlistKey": "fake", "setlistName": "Fake", "currentPosition": 9, "slots": []}
    def save_preset_as(self, setlist_key, position, name, expected_preset_name, expected_position, confirm_overwrite):
        return {"detail": f"save {position}:{name}:{confirm_overwrite}", "savedName": name, "snapshot": self.snapshot()}
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

    def test_status_reports_save_as_and_remaining_write_lock(self):
        result = self.request("system.status")["result"]
        self.assertTrue(result["gatewayAvailable"])
        self.assertIn("preset Save As", result["message"])
        self.assertIn("other persistent writes remain locked", result["message"])

    def test_reconnect_and_snapshot(self):
        self.assertEqual(self.request("device.reconnect")["result"]["phase"], "ready")
        self.assertEqual(self.request("device.snapshot")["result"]["presetName"], "Test")
        self.assertEqual(self.request("device.disconnect")["result"]["phase"], "disconnected")

    def test_unknown_method_uses_json_rpc_error(self):
        self.assertEqual(self.request("device.mutate")["error"]["code"], -32601)

    def test_boolean_request_id_is_rejected(self):
        response = self.service.handle({"jsonrpc": "2.0", "id": True, "method": "system.status"})
        self.assertEqual(response["error"]["code"], -32600)

    def test_live_control_methods_are_dispatched_with_params(self):
        scene = self.request("device.selectScene", {"scene": 3, "expectedPresetName": "Test"})
        bypass = self.request("device.toggleBypass", {
            "row": 2, "column": 4, "expectedScene": 3, "expectedBypassed": False,
            "desiredBypassed": True, "expectedPresetName": "Test"
        })
        tuner = self.request("device.showTuner", {"shown": True})
        gig = self.request("device.showGigView", {"shown": True})
        presets = self.request("device.listPresets")
        bank = self.request("device.navigateBank", {
            "direction": 1, "expectedPresetName": "Test", "expectedPosition": 9
        })
        recall = self.request("device.recallPreset", {
            "setlistKey": "fake", "position": 17,
            "expectedPresetName": "Test", "expectedPosition": 9
        })
        reload = self.request("device.reloadPreset", {
            "expectedPresetName": "Test", "expectedPosition": 9
        })
        details = self.request("device.blockDetails", {
            "row": 0, "column": 1, "expectedPresetName": "Test"
        })
        parameter = self.request("device.setParameter", {
            "row": 0, "column": 1, "parameterIndex": 2,
            "value": 0.75, "expectedValue": 0.5, "expectedScene": 0,
            "expectedPresetName": "Test"
        })
        tempo = self.request("device.setTempo", {
            "bpm": 121, "expectedTempo": 120, "expectedPresetName": "Test"
        })
        footswitch = self.request("device.pressFootswitch", {
            "index": 4, "expectedMode": "STOMP", "expectedPresetName": "Test"
        })
        slots = self.request("device.listPresetSlots")
        saved = self.request("device.savePresetAs", {
            "setlistKey": "fake", "position": 17, "name": "Copy",
            "expectedPresetName": "Test", "expectedPosition": 9,
            "confirmOverwrite": True
        })
        self.assertEqual(scene["result"]["detail"], "scene 3")
        self.assertEqual(bypass["result"]["detail"], "bypass 2:4:3:False:True")
        self.assertEqual(tuner["result"]["detail"], "tuner True")
        self.assertEqual(gig["result"]["detail"], "gig True")
        self.assertEqual(presets["result"]["setlistName"], "Fake")
        self.assertEqual(bank["result"]["detail"], "bank 1:9")
        self.assertEqual(recall["result"]["detail"], "recall fake:17")
        self.assertEqual(reload["result"]["detail"], "reload 9")
        self.assertEqual(details["result"]["name"], "Fake block")
        self.assertEqual(parameter["result"]["detail"], "parameter 2:0.75")
        self.assertEqual(tempo["result"]["detail"], "tempo 121:120")
        self.assertEqual(footswitch["result"]["detail"], "footswitch 4:STOMP")
        self.assertEqual(slots["result"]["setlistName"], "Fake")
        self.assertEqual(saved["result"]["detail"], "save 17:Copy:True")


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
