from __future__ import annotations

import io
import ast
import inspect
import json
from pathlib import Path
import subprocess
import struct
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / "services" / "device-gateway" / "src"))

from qc_device_gateway.framing import FramingError, read_frame, write_frame
from qc_device_gateway.generated_gateway_dispatch import GATEWAY_API_VERSION
from qc_device_gateway.service import GatewayService
from qc_device_gateway.device import PyQuadCortexDevice, _block_color, _catalog_audit, _conditional_parameter_hidden, _device_type_name, _editor_parameter_state, _factory_model_metadata, _format_parameter_number, _parameter_enabled, _png_response, _stomp_color
from qc_device_gateway.native_transport import NativeBrokerTransport, _gunzip_bounded


class PositionState:
    def __init__(self, folder_key: str, position: int, is_factory: bool = False):
        self.folder_key = folder_key
        self.position = position
        self.is_factory = is_factory


class NativeTransportSafetyTests(unittest.TestCase):
    def test_semantic_commands_cross_the_broker_without_python_wire_encoding(self):
        class Rpc:
            def __init__(self):
                self.calls = []

            def call(self, method, params=None):
                self.calls.append((method, params))
                return {"accepted": True}

        rpc = Rpc()
        transport = NativeBrokerTransport(rpc)
        transport.select_scene(3)
        transport.set_bypass(1, 2, True)
        transport.set_parameter(1, 2, 4, value=0.75)
        transport.set_parameter(1, 2, 5, text="ON")
        transport.set_tempo(123)
        self.assertEqual([method for method, _ in rpc.calls], [
            "device.command.scene", "device.command.bypass", "device.command.parameter",
            "device.command.parameter", "device.command.tempo",
        ])
        self.assertEqual(rpc.calls[2][1]["value"], 0.75)
        self.assertEqual(rpc.calls[3][1]["text"], "ON")

    def test_gzip_inflation_is_bounded_off_the_usb_reader(self):
        import gzip
        import qc_device_gateway.native_transport as native_transport

        self.assertEqual(_gunzip_bounded(gzip.compress(b"model repo")), b"model repo")
        with patch.object(native_transport, "MAX_INFLATED_BYTES", 8):
            with self.assertRaisesRegex(ValueError, "inflated-size limit"):
                _gunzip_bounded(gzip.compress(b"too much model metadata"))


class DevicePositionTests(unittest.TestCase):
    def test_io_settings_project_every_port_family_and_dispatch_sparse_writes(self):
        class Message(SimpleNamespace):
            def HasField(self, field):
                return hasattr(self, field)

        io = Message(
            settings=Message(
                in_port=[Message(input_port_id=1, level=0.5, plugged=True)],
                out_port=[Message(output_port_id=4, level=0.75, mute=False)],
                exp_port=[Message(exp_port_id=1, plugged=True, level=0.2)],
                hp_port=Message(level=0.4, plugged=True,
                                hp_feed=[Message(level=0.6, output_port_id=4)]),
                usb_port=Message(level=0.3, hp_select=0.5, plugged=True, dry_wet=1.0),
                midi_port=Message(midi_thru=1.0),
            ),
            xlr1_2_linked=True,
            out3_4_linked=False,
        )

        class Session:
            def io_settings(self):
                return io

            def set_input_port(self, port, **values):
                self.input = (port, values)

            def set_output_port(self, port, **values):
                self.output = (port, values)

            def set_usb_port(self, **values):
                self.usb = values

            def set_midi_thru(self, enabled):
                self.midi = enabled

            def set_output_pairing(self, **values):
                self.pairing = values

        session = Session()
        device = PyQuadCortexDevice()
        device._qc = session
        projected = device.io_settings()
        self.assertEqual(projected["inputs"][0]["levelDb"], 24.0)
        self.assertTrue(projected["headphones"]["plugged"])
        self.assertEqual(projected["usb"]["dryWet"], 1.0)
        self.assertEqual(projected["midi"]["thru"], 1.0)
        self.assertTrue(projected["xlr12Linked"])

        with patch("qc_device_gateway.device._protocol_api",
                   return_value=SimpleNamespace(Db=lambda value: ("db", value),
                                                Encoded=lambda value: ("encoded", value))):
            device.set_input_port(1, 12.0, None, 1.0, None)
            device.set_output_port(4, 0.75, None, False)
            device.set_usb_port(0.25, None, 1.0)
        device.set_midi_thru(True)
        device.set_output_pairing(True, None)
        self.assertEqual(session.input, (1, {"level": ("db", 12.0), "impedance": None,
                                             "input_type": 1.0, "ground_lift": None}))
        self.assertEqual(session.output[1]["level"], ("encoded", 0.75))
        self.assertEqual(session.usb["dry_wet"], 1.0)
        self.assertTrue(session.midi)
        self.assertEqual(session.pairing, {"xlr1_2": True, "out3_4": None})

    def test_general_settings_project_sparse_state_and_validate_all_writes(self):
        class Message(SimpleNamespace):
            def HasField(self, field):
                return hasattr(self, field)

        settings = Message(
            screen_brightness=72,
            hold_timing=3,
            scene_block_bypass=1,
            global_bypass_cab=Message(row1=True, row2=False, row3=True, row4=False),
            master_volume_assignment=Message(out12=True, out34=False, send12=True, headphones=True),
        )

        class Session:
            def settings(self):
                return settings

            def update_settings(self, **values):
                self.updated = values

            def set_master_volume_assignment(self, **values):
                self.assignment = values

            def set_global_bypass(self, **values):
                self.bypass = values

        session = Session()
        device = PyQuadCortexDevice()
        device._qc = session
        projected = device.general_settings()
        self.assertEqual(projected["screenBrightness"], 72)
        self.assertEqual(projected["holdTimingMs"], 800)
        self.assertEqual(projected["sceneBypassBehavior"], "nonstompOverwrite")
        self.assertEqual(projected["globalBypassCab"]["row3"], True)
        self.assertEqual(projected["masterVolumeAssignment"]["send12"], True)

        device.set_general_integer("holdTiming", 5)
        self.assertEqual(session.updated, {"hold_timing": 5})
        device.set_general_toggle("stompModeAutoAssign", False)
        self.assertEqual(session.updated, {"stomp_mode_auto_assign": False})
        device.set_scene_bypass_behavior("neverOverwrite")
        self.assertEqual(session.updated, {"scene_block_bypass": 2})
        device.set_master_volume_assignment(True, False, True, False)
        self.assertEqual(session.assignment, {
            "out12": True, "out34": False, "send12": True, "headphones": False,
        })
        device.set_global_bypass([True, False, True, False], [False, True, False, True])
        self.assertEqual(session.bypass["cab"], [True, False, True, False])

        with self.assertRaises(ValueError):
            device.set_general_integer("holdTiming", 6)
        with self.assertRaises(ValueError):
            device.set_general_toggle("unknown", True)
        with self.assertRaises(ValueError):
            device.set_scene_bypass_behavior("sometimes")
        with self.assertRaises(ValueError):
            device.set_global_bypass([True], [False] * 4)

    def test_parameter_assignment_methods_use_public_api_and_verify_readback(self):
        parameter = {
            "index": 4, "writable": True, "sceneMode": False,
            "expressionAssignable": True, "expression": None,
            "expressionMinimum": None, "expressionMaximum": None,
        }

        class Session:
            def set_param_scene_mode(self, row, column, index, enabled):
                self.scene_call = (row, column, index, enabled)
                parameter["sceneMode"] = enabled

            def set_expression(self, row, column, index, pedal, minimum, maximum):
                self.expression_call = (row, column, index, pedal, minimum, maximum)
                parameter.update(expression=pedal, expressionMinimum=minimum, expressionMaximum=maximum)

        device = PyQuadCortexDevice()
        session = Session()
        device._qc = session
        device.block_details = lambda row, column, expected="": {"parameters": [parameter]}
        with patch("qc_device_gateway.device._wait_for_dirty", return_value=True):
            scene = device.set_parameter_scene_mode(1, 2, 4, True, "Live")
            expression = device.set_parameter_expression(1, 2, 4, 2, 0.8, 0.2, "Live")
        self.assertEqual(session.scene_call, (1, 2, 4, True))
        self.assertEqual(session.expression_call, (1, 2, 4, 2, 0.8, 0.2))
        self.assertIn("verified", scene["detail"])
        self.assertIn("verified", expression["detail"])

    def test_parameter_assignment_validation_rejects_unsafe_values(self):
        device = PyQuadCortexDevice()
        device.block_details = lambda row, column, expected="": {
            "parameters": [{"index": 1, "writable": True, "expressionAssignable": False}]
        }
        with self.assertRaisesRegex(ValueError, r"0 \(clear\), 1, or 2"):
            device.set_parameter_expression(0, 0, 1, 3, 0, 1, "Live")
        with self.assertRaisesRegex(ValueError, "normalized"):
            device.set_parameter_expression(0, 0, 1, 1, -0.1, 1, "Live")
        with self.assertRaisesRegex(RuntimeError, "cannot be assigned"):
            device.set_parameter_expression(0, 0, 1, 1, 0, 1, "Live")

    def test_stomp_metadata_methods_choose_storage_and_verify_readback(self):
        assignment = SimpleNamespace(footswitch=3)
        preset = SimpleNamespace(
            stomp_is_momentary={}, stomp_labels={}, single_stomp_labels={},
        )

        class Session:
            def set_stomp_momentary(self, footswitch, momentary):
                preset.stomp_is_momentary[footswitch] = momentary

            def set_stomp_label(self, footswitch, label, single=False):
                (preset.single_stomp_labels if single else preset.stomp_labels)[footswitch] = label

            def read_current_preset(self):
                return preset

        protocol = SimpleNamespace(stomp_assignments=lambda current: [assignment])
        device = PyQuadCortexDevice()
        device._qc = Session()
        device._assert_expected_preset = lambda expected: preset
        device.snapshot = lambda: {"presetName": "Live"}
        with patch("qc_device_gateway.device._protocol_api", return_value=protocol), \
             patch("qc_device_gateway.device._wait_for_dirty", return_value=True):
            momentary = device.set_stomp_momentary(3, True, "Live")
            label = device.set_stomp_label(3, "Solo", "Live")
        self.assertTrue(preset.stomp_is_momentary[3])
        self.assertEqual(preset.single_stomp_labels[3], "Solo")
        self.assertIn("verified", momentary["detail"])
        self.assertIn("verified", label["detail"])

    def test_split_mute_uses_mix_bypass_readback_and_rejects_stale_state(self):
        chain = SimpleNamespace(row=0, mixBypass=[SimpleNamespace(bypass=False)])
        preset = SimpleNamespace(chains=[chain])

        class Session:
            def set_split_mute(self, row, muted):
                self.last_write = (row, muted)
                chain.mixBypass = [SimpleNamespace(bypass=muted) for _ in range(8)]

            def read_current_preset(self):
                return preset

        session = Session()
        device = PyQuadCortexDevice()
        device._qc = session
        device._assert_expected_preset = lambda expected: preset
        device.snapshot = lambda: {"presetName": "Live"}
        protocol = SimpleNamespace(field_present=lambda value, field: field == "row")
        with patch("qc_device_gateway.device._protocol_api", return_value=protocol), \
             patch("qc_device_gateway.device._wait_for_dirty", return_value=True):
            result = device.set_split_mute(0, True, False, "Live")
            self.assertEqual(session.last_write, (0, True))
            self.assertIn("muted and verified", result["detail"])
            with self.assertRaisesRegex(RuntimeError, "changed"):
                device.set_split_mute(0, False, False, "Live")

    def test_preset_midi_out_methods_validate_and_verify_replacement(self):
        state = {"source": [], "load": []}
        midi = lambda **values: SimpleNamespace(**values)
        protocol = SimpleNamespace(
            MidiOut=midi,
            midi_out=lambda preset, source: state["source"],
            preset_load_midi_out=lambda preset: state["load"],
        )

        class Session:
            def set_midi_out(self, source, messages):
                self.source = source
                state["source"] = messages

            def set_preset_load_midi_out(self, messages):
                state["load"] = messages

            def read_current_preset(self):
                return object()

        messages = [{"type": 1, "channel": 3, "param1": 10, "param2": 5, "param3": 120}]
        device = PyQuadCortexDevice()
        session = Session()
        device._qc = session
        device._assert_expected_preset = lambda expected: object()
        device.snapshot = lambda: {"presetName": "Live"}
        with patch("qc_device_gateway.device._protocol_api", return_value=protocol), \
             patch("qc_device_gateway.device._wait_for_dirty", return_value=True):
            source = device.set_midi_out(8, messages, "Live")
            preset_load = device.set_preset_load_midi_out(messages, "Live")
        self.assertEqual(session.source, 8)
        self.assertIn("verified", source["detail"])
        self.assertIn("verified", preset_load["detail"])
        with self.assertRaisesRegex(ValueError, "at most 12"):
            device.set_midi_out(0, messages * 13, "Live")

    def test_expression_bypass_uses_typed_delay_and_verifies_all_fields(self):
        assignment = SimpleNamespace(expression=0, expression_min=0.0, expression_max=1.0)
        info = SimpleNamespace(type=0, invert=False, delay_ms=0, latch_emulation=False)

        class Model:
            column = 2
            bypass_expression = [assignment]
            expression_bypass_info = [info]
            def HasField(self, field):
                return field == "column"

        preset = SimpleNamespace(chains=[SimpleNamespace(models=[Model()])])
        class Milliseconds(float):
            pass
        class Session:
            def set_expression_bypass(self, row, column, pedal, mode, invert, delay, latch):
                self.delay = delay
                assignment.expression = pedal
                info.type, info.invert, info.delay_ms, info.latch_emulation = mode, invert, int(delay), latch
            def read_current_preset(self):
                return preset
            def preset_dirty(self):
                return True

        session = Session()
        device = PyQuadCortexDevice()
        device._qc = session
        device._assert_expected_preset = lambda expected: preset
        device.snapshot = lambda: {"presetName": "Live"}
        with patch("qc_device_gateway.device._protocol_api", return_value=SimpleNamespace(Milliseconds=Milliseconds)):
            result = device.set_expression_bypass(0, 2, 2, 1, True, 250, True, "Live")
        self.assertIsInstance(session.delay, Milliseconds)
        self.assertIn("verified", result["detail"])
        with self.assertRaisesRegex(ValueError, "1 or 2"):
            device.set_expression_bypass(0, 2, 0, 1, False, 0, False, "Live")

    def test_block_details_prefers_the_shared_native_state_projection(self):
        expected = {
            "row": 1, "column": 2, "modelId": 101, "name": "Shared",
            "category": "Delay", "scene": 3,
            "parameters": [{"index": 4, "normalizedValue": 0.5, "writable": True, "options": []}],
        }

        class NativeState:
            def block_details(self, row, column, preset_name):
                self.call = (row, column, preset_name)
                return expected

        transport = NativeState()
        device = PyQuadCortexDevice()
        device._qc = SimpleNamespace(_t=transport)
        self.assertIs(device.block_details(1, 2, "Live"), expected)
        self.assertEqual(transport.call, (1, 2, "Live"))
        self.assertEqual(device._live_editor_context["parameters"], {4})

    def test_parameter_preview_is_read_free_and_bound_to_verified_editor_context(self):
        writes = []
        device = PyQuadCortexDevice()
        device._qc = SimpleNamespace(set_param=lambda row, column, **values: writes.append((row, column, values)))
        device._live_editor_context = {
            "row": 1, "column": 3, "scene": 2, "presetName": "Live",
            "parameters": {4},
        }
        result = device.preview_parameter(1, 3, 4, 0.625, 2, "Live")
        self.assertEqual(result["acceptedValue"], 0.625)
        self.assertEqual(writes, [(1, 3, {"param_index": 4, "value": 0.625})])
        with self.assertRaisesRegex(RuntimeError, "context changed"):
            device.preview_parameter(1, 3, 4, 0.75, 3, "Live")

    def test_native_transport_covers_every_pycortex_message_type_and_client_transport_operation(self):
        import pyquadcortex
        from pyquadcortex import registry

        self.assertEqual(set(registry._BY_TYPE), set(range(1, 71)))
        source = inspect.getsource(pyquadcortex.QuadCortex)
        tree = ast.parse(source)
        public_methods = {
            name for name, value in inspect.getmembers(pyquadcortex.QuadCortex, inspect.isfunction)
            if not name.startswith("_")
        }
        self.assertEqual(len(public_methods), 109)
        referenced_messages = {
            node.attr for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "pa"
            and node.attr.endswith("Message")
        }
        registered_messages = {message.__name__ for message in registry._BY_TYPE.values()}
        self.assertFalse(referenced_messages - registered_messages)
        required_operations = {"send", "request", "next_request_id", "collect", "await_broadcast"}
        used_operations = {
            node.attr for node in ast.walk(tree)
            if isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Attribute)
            and isinstance(node.value.value, ast.Name)
            and node.value.value.id == "self"
            and node.value.attr == "_t"
        }
        self.assertFalse(used_operations - required_operations)
        for operation in required_operations:
            self.assertTrue(callable(getattr(NativeBrokerTransport, operation)))

    def test_connect_defers_directory_flood_until_directory_is_requested(self):
        class QuadCortex:
            _SUBSCRIBE_TYPES = ("ModuleStats", "File", "RecallPreset", "Scene")

        session = SimpleNamespace(close=lambda: None)
        module = SimpleNamespace(QuadCortex=QuadCortex, connect=lambda: session)
        device = PyQuadCortexDevice()
        device._read_position_state = lambda: PositionState("/media/p4/Presets/My Presets", 0)
        with patch.dict(sys.modules, {"pyquadcortex": module}):
            device.reconnect()
        self.assertEqual(QuadCortex._SUBSCRIBE_TYPES, ("ModuleStats", "RecallPreset", "Scene"))
        self.assertIs(device._qc, session)

    def test_preset_directory_keeps_all_slots_and_labels_empty_ones_unsaved(self):
        class PresetEntry:
            def __init__(self, index: int, name: str | None, instrument: int | None = None):
                self.index = index
                self.name = name or ""
                self.instrument = instrument or 0

            def HasField(self, field: str) -> bool:
                return field == "index" or (field == "name" and bool(self.name)) or (field == "instrument" and bool(self.instrument))

        class Session:
            def list_presets(self, setlist_key: str, timeout: float, include_empty: bool):
                self.request = (setlist_key, timeout, include_empty)
                return [PresetEntry(0, "Stored", 2), PresetEntry(2, None)]

        device = PyQuadCortexDevice()
        session = Session()
        device._qc = session
        device._preset_folder_cache = []
        device._current_position = lambda refresh=False: ("/media/p4/Presets/My Presets", 0, False)
        result = device.list_presets(refresh=True)
        self.assertEqual(session.request, ("/media/p4/Presets/My Presets", 25.0, True))
        self.assertEqual(len(result["presets"]), 256)
        self.assertEqual(result["presets"][0]["name"], "Stored")
        self.assertEqual(result["presets"][1]["name"], "Unsaved")
        self.assertEqual(result["presets"][2]["name"], "Unsaved")

    def test_copy_preset_requires_confirmation_and_verifies_the_destination(self):
        class Session:
            def __init__(self):
                self.copy_args = None

            def preset_dirty(self):
                return False

            def copy_preset(self, source_key, source_position, destination_key, **kwargs):
                self.copy_args = (source_key, source_position, destination_key, kwargs)
                return "Source"

        device = PyQuadCortexDevice()
        session = Session()
        device._qc = session
        device._current_position = lambda refresh=False: ("destination", 9, False)
        device._assert_expected_preset = lambda expected_name: SimpleNamespace(name=expected_name)
        device.list_presets = lambda refresh=False, setlist_key=None: {
            "presets": [{"position": 1, "location": "1B", "name": "Source", "instrument": 2}]
        }
        device.snapshot = lambda: {"presetName": "Source", "dirty": False, "presetLocation": "2B"}

        with self.assertRaisesRegex(RuntimeError, "explicit overwrite confirmation"):
            device.copy_preset("source", 1, "Source", "destination", 9, "Target", 9, False)

        result = device.copy_preset("source", 1, "Source", "destination", 9, "Target", 9, True)
        self.assertEqual(
            session.copy_args,
            ("source", 1, "destination", {"to_position": 9, "name": "Source", "instrument": 2}),
        )
        self.assertEqual(result["savedName"], "Source")
        self.assertIn("and verified", result["detail"])

    def test_copy_preset_rejects_a_changed_source(self):
        device = PyQuadCortexDevice()
        device._qc = SimpleNamespace(preset_dirty=lambda: False)
        device._current_position = lambda refresh=False: ("destination", 9, False)
        device._assert_expected_preset = lambda expected_name: SimpleNamespace(name=expected_name)
        device.list_presets = lambda refresh=False, setlist_key=None: {
            "presets": [{"position": 1, "location": "1B", "name": "Renamed", "instrument": 0}]
        }
        with self.assertRaisesRegex(RuntimeError, "copied source changed"):
            device.copy_preset("source", 1, "Source", "destination", 9, "Target", 9, True)

    def test_every_factory_device_type_uses_its_qc_screen_name(self):
        expected = {
            "BassAmplifier": "Bass Amp", "BassOverdrive": "Bass Overdrive",
            "CabsimBassM": "Bass Cab", "CabsimBassST": "Bass Cab",
            "CabsimGuitarM": "Guitar Cab", "CabsimGuitarST": "Guitar Cab",
            "Compressor": "Compressor", "Delay": "Delay", "Equalizer": "EQ",
            "FXLoop": "FX Loop", "Filter": "Filter", "GuitarAmplifier": "Guitar Amp",
            "GuitarOverdrive": "Guitar Overdrive", "IRLoaders": "IR Loader",
            "Loopers": "Looper", "Modulation": "Modulation", "Morph": "Morph",
            "Pitch": "Pitch", "Reverb": "Reverb", "Synth": "Synth",
            "Utility": "Utility", "Wah": "Wah",
        }
        self.assertEqual({raw: _device_type_name(raw) for raw in expected}, expected)
        self.assertEqual(_device_type_name("Cabsim Guitar (M)"), "Guitar Cab")
        self.assertEqual(_device_type_name("Cabsim Bass (ST)"), "Bass Cab")

    def test_parameter_display_removes_negative_zero_after_rounding(self):
        self.assertEqual(_format_parameter_number(-0.00001, 1), "0.0")
        self.assertEqual(_format_parameter_number(-0.00001, 2), "0.00")
        self.assertEqual(_format_parameter_number(-0.04, 1), "0.0")
        self.assertEqual(_format_parameter_number(-0.06, 1), "-0.1")

    def test_model_repo_dependencies_cover_binary_and_multi_step_controllers(self):
        self.assertTrue(_parameter_enabled({"enableWhenOn": 6, "enableWhenOff": None, "enableWhenSteps": []}, {6: 1.0}, {6: 2}))
        self.assertFalse(_parameter_enabled({"enableWhenOn": 6, "enableWhenOff": None, "enableWhenSteps": []}, {6: 0.0}, {6: 2}))
        self.assertTrue(_parameter_enabled({"enableWhenOn": None, "enableWhenOff": 6, "enableWhenSteps": []}, {6: 0.0}, {6: 2}))
        self.assertFalse(_parameter_enabled({"enableWhenOn": None, "enableWhenOff": 6, "enableWhenSteps": []}, {6: 1.0}, {6: 2}))
        stepped = {"enableWhenOn": 6, "enableWhenOff": None, "enableWhenSteps": [2, 3]}
        self.assertTrue(_parameter_enabled(stepped, {6: 2 / 3}, {6: 4}))
        self.assertFalse(_parameter_enabled(stepped, {6: 1 / 3}, {6: 4}))

    def test_minivoicer_uses_quantize_to_select_each_shared_screen_control(self):
        quantized = {4: 1.0}
        chromatic = {4: 0.0}
        self.assertFalse(_conditional_parameter_hidden(18007, 7, quantized))
        self.assertTrue(_conditional_parameter_hidden(18007, 20, quantized))
        self.assertTrue(_conditional_parameter_hidden(18007, 7, chromatic))
        self.assertFalse(_conditional_parameter_hidden(18007, 20, chromatic))
        self.assertFalse(_conditional_parameter_hidden(7003, 7, quantized))

    def test_refreshes_cached_position_after_physical_device_navigation(self):
        device = PyQuadCortexDevice()
        device._setlist_key = "/media/p4/Presets/Test/"
        device._preset_position = 0
        device._read_position_state = lambda: PositionState("/media/p4/Presets/Test/", 19)

        self.assertEqual(device._current_position(), ("/media/p4/Presets/Test/", 0, False))
        self.assertEqual(device._current_position(refresh=True), ("/media/p4/Presets/Test/", 19, False))

    def test_empty_preset_placeholder_passes_expected_name_guard(self):
        class EmptyPreset:
            name = ""

        class Session:
            def read_current_preset(self):
                return EmptyPreset()

        device = PyQuadCortexDevice()
        device._qc = Session()

        self.assertIsInstance(device._assert_expected_preset("Unsaved"), EmptyPreset)
        self.assertIsInstance(device._assert_expected_preset("Empty preset"), EmptyPreset)
        self.assertIsInstance(device._assert_expected_preset("Current preset"), EmptyPreset)

    def test_live_snapshot_does_not_implicitly_fetch_the_model_catalog(self):
        import inspect

        source = inspect.getsource(PyQuadCortexDevice.snapshot)
        self.assertNotIn("qc.catalog", source)
        self.assertIn('getattr(qc, "_catalog", None)', source)

    def test_individual_save_never_enumerates_or_recalls_the_library(self):
        import inspect

        source = inspect.getsource(PyQuadCortexDevice.save_preset_as)
        self.assertNotIn("list_preset_slots(", source)
        self.assertNotIn("self.list_presets(", source)
        self.assertNotIn("qc.read_preset(", source)
        self.assertIn("confirm=False", source)
        self.assertIn("qc.read_current_preset", source)

    def test_individual_recall_uses_only_the_target_and_active_records(self):
        import inspect

        source = inspect.getsource(PyQuadCortexDevice._recall_position)
        self.assertNotIn("list_presets(", source)
        self.assertIn("qc.read_preset(setlist_key, position", source)
        self.assertIn("snapshot = self.snapshot()", source)

    def test_factory_models_keep_useful_names_and_led_categories_before_catalog_load(self):
        name, category = _factory_model_metadata(4)
        self.assertEqual(name, "Rodent Drive")
        self.assertEqual(category, "Guitar Overdrive")
        self.assertEqual(_block_color(category, name), "#ff7000")


class FakeDevice:
    def __init__(self):
        self.closed = False

    def close(self): self.closed = True
    def reconnect(self): return {"phase": "ready", "detail": "fake ready", "demo": False}
    def reset_session(self): return self.reconnect()
    def disconnect(self): return {"phase": "disconnected", "detail": "fake closed", "demo": True}
    def snapshot(self): return {"presetName": "Test", "blocks": []}
    def tempo_clock_state(self): return {"available": True, "sequence": 7, "receivedAtUnixMs": 123456, "currentBeat": 2, "currentBar": 3, "currentTick": 1}
    def state_events(self, after_sequence=0, limit=256):
        return {"native": True, "frames": [{"sequence": after_sequence + 1, "observedAt": 123456, "states": [{"kind": "scene", "activeScene": 2}]}][:limit]}
    def list_models(self): return {"models": [{"id": 123, "name": "Fake model", "category": "Test", "basedOn": ""}]}
    def identity(self): return {"serial": "fake-serial", "appFwVersion": "4.1.0", "customName": "Stage QC", "deviceType": 0}
    def set_device_name(self, name): return {"detail": f"name {name}"}
    def undo(self): return {"detail": "undo"}
    def redo(self): return {"detail": "redo"}
    def inhibited_modules(self): return {"globalGate": False, "globalEq": True}
    def tuner_settings(self): return {"inputPortId": 1, "referenceOffsetHz": 2.0, "referenceHz": 442.0, "muted": False}
    def preset_screenshot(self, folder_name, position, is_factory=False):
        return {"pngBase64": "preset", "width": 800, "height": 384, "target": f"{folder_name}:{position}:{is_factory}"}
    def capture_screen(self): return {"pngBase64": "screen", "width": 800, "height": 480}
    def tap_screen(self, x, y): return {"detail": f"tap {x}:{y}"}
    def select_scene(self, scene, expected_preset_name=""):
        return {"detail": f"scene {scene}", "snapshot": self.snapshot()}
    def copy_scene(self, from_scene, to_scene, swap=False, expected_preset_name=""):
        return {"detail": f"scene-copy {from_scene}:{to_scene}:{swap}", "snapshot": self.snapshot()}
    def set_scene_label(self, scene, label, expected_preset_name=""):
        return {"detail": f"scene-label {scene}:{label}", "snapshot": self.snapshot()}
    def set_scene_color(self, scene, color, expected_preset_name=""):
        return {"detail": f"scene-color {scene}:{color}", "snapshot": self.snapshot()}
    def toggle_bypass(self, row, column, expected_scene, expected_bypassed, desired_bypassed, expected_preset_name=""):
        return {"detail": f"bypass {row}:{column}:{expected_scene}:{expected_bypassed}:{desired_bypassed}", "snapshot": self.snapshot()}
    def move_block(self, row, from_column, to_column, expected_model_id, expected_preset_name=""):
        return {"detail": f"move {row}:{from_column}:{to_column}:{expected_model_id}", "snapshot": self.snapshot()}
    def add_block(self, row, column, model_id, expected_preset_name=""):
        return {"detail": f"add {row}:{column}:{model_id}", "snapshot": self.snapshot()}
    def remove_block(self, row, column, expected_model_id, expected_preset_name=""):
        return {"detail": f"remove {row}:{column}:{expected_model_id}", "snapshot": self.snapshot()}
    def set_block_footswitch(self, row, column, footswitch, expected_footswitch, expected_model_id, expected_preset_name=""):
        return {"detail": f"assign {row}:{column}:{footswitch}:{expected_footswitch}:{expected_model_id}", "snapshot": self.snapshot()}
    def set_chain_input(self, row, input_id, expected_input_id, expected_preset_name=""):
        return {"detail": f"input {row}:{input_id}:{expected_input_id}", "snapshot": self.snapshot()}
    def set_chain_output(self, row, output_id, expected_output_id, expected_preset_name=""):
        return {"detail": f"output {row}:{output_id}:{expected_output_id}", "snapshot": self.snapshot()}
    def set_chain_split(self, row, split_column, mix_column, expected_split_column, expected_mix_column, expected_preset_name=""):
        return {"detail": f"split {row}:{split_column}:{mix_column}:{expected_split_column}:{expected_mix_column}", "snapshot": self.snapshot()}
    def set_split_mute(self, row, muted, expected_muted, expected_preset_name=""):
        return {"detail": f"split-mute {row}:{muted}:{expected_muted}", "snapshot": self.snapshot()}
    def list_presets(self, refresh=False, setlist_key=None):
        return {"setlistKey": setlist_key or "fake", "setlistName": "Fake", "currentPosition": 9, "presets": [], "folders": []}
    def list_preset_folders(self, refresh=False):
        return {"folders": [{"key": "fake", "name": "Fake", "isFactory": False}]}
    def navigate_bank(self, direction, expected_preset_name, expected_position):
        return {"detail": f"bank {direction}:{expected_position}", "snapshot": self.snapshot()}
    def recall_preset(self, setlist_key, position, expected_preset_name, expected_position):
        return {"detail": f"recall {setlist_key}:{position}", "snapshot": self.snapshot()}
    def reload_preset(self, expected_preset_name, expected_position):
        return {"detail": f"reload {expected_position}", "snapshot": self.snapshot()}
    def block_details(self, row, column, expected_preset_name=""):
        return {"row": row, "column": column, "name": "Fake block", "parameters": []}
    def preview_parameter(self, row, column, parameter_index, value, expected_scene, expected_preset_name):
        return {"detail": f"preview {parameter_index}:{value}", "acceptedValue": value}
    def set_parameter(self, row, column, parameter_index, value, expected_value, expected_scene, expected_preset_name):
        return {"detail": f"parameter {parameter_index}:{value}", "block": self.block_details(row, column), "snapshot": self.snapshot()}
    def set_parameter_scene_mode(self, row, column, parameter_index, enabled, expected_preset_name):
        return {"detail": f"scene-mode {parameter_index}:{enabled}"}
    def set_parameter_expression(self, row, column, parameter_index, pedal, minimum, maximum, expected_preset_name):
        return {"detail": f"expression {parameter_index}:{pedal}:{minimum}:{maximum}"}
    def set_expression_bypass(self, row, column, pedal, mode, invert, delay_ms, latch_emulation, expected_preset_name):
        return {"detail": f"expression-bypass {row}:{column}:{pedal}:{mode}:{invert}:{delay_ms}:{latch_emulation}"}
    def set_stomp_momentary(self, footswitch, momentary, expected_preset_name):
        return {"detail": f"stomp-momentary {footswitch}:{momentary}"}
    def set_stomp_label(self, footswitch, label, expected_preset_name):
        return {"detail": f"stomp-label {footswitch}:{label}"}
    def set_midi_out(self, source, messages, expected_preset_name):
        return {"detail": f"midi-out {source}:{len(messages)}"}
    def set_preset_load_midi_out(self, messages, expected_preset_name):
        return {"detail": f"preset-midi-out {len(messages)}"}
    def set_tempo(self, bpm, expected_tempo, expected_preset_name):
        return {"detail": f"tempo {bpm}:{expected_tempo}", "snapshot": self.snapshot()}
    def set_master_volume(self, value, expected_value):
        return {"detail": f"volume {value}:{expected_value}", "snapshot": self.snapshot()}
    def master_volume_state(self):
        return {"value": 56}
    def press_footswitch(self, index, expected_mode, expected_preset_name):
        return {"detail": f"footswitch {index}:{expected_mode}", "snapshot": self.snapshot()}
    def tap_tempo(self, expected_mode, expected_preset_name):
        return {"detail": f"tap-tempo {expected_mode}"}
    def select_mode_slot(self, slot, expected_preset_name):
        return {"detail": f"mode-slot {slot}", "snapshot": self.snapshot()}
    def list_preset_slots(self):
        return {"setlistKey": "fake", "setlistName": "Fake", "currentPosition": 9, "slots": []}
    def save_preset_as(self, setlist_key, position, name, expected_preset_name, expected_position, confirm_overwrite):
        return {"detail": f"save {position}:{name}:{confirm_overwrite}", "savedName": name, "snapshot": self.snapshot()}
    def copy_preset(self, source_setlist_key, source_position, source_name, destination_setlist_key, destination_position, expected_preset_name, expected_position, confirm_overwrite):
        return {"detail": f"copy {source_setlist_key}:{source_position}:{destination_setlist_key}:{destination_position}:{confirm_overwrite}", "savedName": source_name, "snapshot": {**self.snapshot(), "presetName": source_name}}
    def rename_current_preset(self, name, expected_preset_name, expected_position, confirm_rename):
        return {"detail": f"rename {expected_position}:{name}:{confirm_rename}", "savedName": name, "snapshot": {**self.snapshot(), "presetName": name}}
    def create_device_backup(self, name):
        return {"type": "backup", "creator": "quad", "name": name, "payload": "AA==", "payload_hash": "0" * 64}
    def show_tuner(self, shown=True): return {"detail": f"tuner {shown}"}
    def show_gig_view(self, shown=True): return {"detail": f"gig {shown}"}


class PyQuadCortexParityTests(unittest.TestCase):
    @staticmethod
    def png(width=800, height=480):
        return b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + width.to_bytes(4, "big") + height.to_bytes(4, "big")

    def test_png_projection_matches_the_rust_gateway_shape(self):
        projected = _png_response(self.png(800, 384))
        self.assertEqual((projected["width"], projected["height"]), (800, 384))
        self.assertTrue(projected["pngBase64"].startswith("iVBOR"))
        with self.assertRaisesRegex(RuntimeError, "valid PNG"):
            _png_response(b"not a PNG")

    def test_identity_and_inhibited_modules_are_projected_to_camel_case(self):
        class Message:
            device_serial_number = "serial-1"
            app_fw_version = "4.1.0"
            custom_name = "Stage QC"
            device_type = 0
            global_gate = False
            global_eq = True

            def HasField(self, name):
                return name in {
                    "device_serial_number", "app_fw_version", "custom_name",
                    "device_type", "global_gate", "global_eq",
                }

        qc = SimpleNamespace(version=lambda: Message(), inhibited_modules=lambda: Message())
        device = PyQuadCortexDevice()
        device._qc = qc
        self.assertEqual(device.identity(), {
            "serial": "serial-1", "appFwVersion": "4.1.0",
            "customName": "Stage QC", "deviceType": 0,
        })
        self.assertEqual(device.inhibited_modules(), {"globalGate": False, "globalEq": True})

    def test_tuner_settings_read_projects_offset_and_absolute_reference(self):
        qc = SimpleNamespace(tuner=lambda: SimpleNamespace(
            input_port_id=5, frequency=1.99999809, mute=True,
            HasField=lambda field: field in {"input_port_id", "frequency", "mute"},
        ))
        device = PyQuadCortexDevice()
        device._qc = qc
        result = device.tuner_settings()
        self.assertEqual(result["inputPortId"], 5)
        self.assertAlmostEqual(result["referenceOffsetHz"], 1.99999809)
        self.assertAlmostEqual(result["referenceHz"], 441.99999809)
        self.assertTrue(result["muted"])

    def test_tuner_writes_require_acknowledgement_and_preserve_upstream_units(self):
        calls = []
        qc = SimpleNamespace(
            set_tuner_input=lambda value: calls.append(("input", value)),
            set_tuner_mute=lambda value: calls.append(("mute", value)),
            restore_audio=lambda: calls.append(("restore",)) or True,
            set_tuner_reference=lambda value: calls.append(("reference", value)),
        )
        device = PyQuadCortexDevice()
        device._qc = qc
        with self.assertRaisesRegex(ValueError, "confirmTunerActivation"):
            device.set_tuner_mute(True, False)
        device.set_tuner_input(8, True)
        device.set_tuner_mute(False, True)
        self.assertTrue(device.restore_tuner_audio(True)["acted"])
        with patch("qc_device_gateway.device._protocol_api", return_value=SimpleNamespace(Hertz=lambda value: ("Hz", value))):
            device.set_tuner_reference(2.0, True)
        self.assertEqual(calls, [
            ("input", 8), ("mute", False), ("restore",), ("reference", ("Hz", 2.0)),
        ])

    def test_history_name_and_remote_screen_delegate_to_pyquadcortex(self):
        calls = []
        image = self.png()
        qc = SimpleNamespace(
            set_device_name=lambda name: calls.append(("name", name)),
            undo=lambda: calls.append(("undo",)),
            redo=lambda: calls.append(("redo",)),
            preset_screenshot=lambda folder, position, is_factory=False: (
                calls.append(("preset", folder, position, is_factory)) or image
            ),
            capture_screen=lambda: calls.append(("capture",)) or image,
            tap_screen=lambda x, y: calls.append(("tap", x, y)),
        )
        device = PyQuadCortexDevice()
        device._qc = qc
        self.assertIn("Stage QC", device.set_device_name("Stage QC")["detail"])
        device.undo()
        device.redo()
        self.assertEqual(device.preset_screenshot("My Presets", 12)["width"], 800)
        self.assertEqual(device.capture_screen()["height"], 480)
        device.tap_screen(799, 479)
        self.assertEqual(calls, [
            ("name", "Stage QC"), ("undo",), ("redo",),
            ("preset", "My Presets", 12, False), ("capture",), ("tap", 799, 479),
        ])

    def test_scene_management_delegates_and_verifies_device_readback(self):
        class Preset:
            name = "Test"

            def __init__(self):
                self.scene_labels = [f"Scene {chr(65 + index)}" for index in range(8)]
                self.scene_colors = [0xFF000000 + index for index in range(8)]

        preset = Preset()
        calls = []

        def copy_scene(source, destination, swap=False):
            calls.append(("copy", source, destination, swap))
            old_destination = (preset.scene_labels[destination], preset.scene_colors[destination])
            preset.scene_labels[destination] = preset.scene_labels[source]
            preset.scene_colors[destination] = preset.scene_colors[source]
            if swap:
                preset.scene_labels[source], preset.scene_colors[source] = old_destination

        def set_scene_label(scene, label):
            calls.append(("label", scene, label))
            preset.scene_labels[scene] = " " if label is None else label

        def set_scene_color(scene, color):
            calls.append(("color", scene, color))
            preset.scene_colors[scene] = color

        qc = SimpleNamespace(
            read_current_preset=lambda: preset,
            copy_scene=copy_scene,
            set_scene_label=set_scene_label,
            set_scene_color=set_scene_color,
            preset_dirty=lambda: True,
        )
        device = PyQuadCortexDevice()
        device._qc = qc
        device.snapshot = lambda: {"presetName": "Test"}

        self.assertIn("copied", device.copy_scene(0, 1, False, "Test")["detail"])
        self.assertIn("label updated", device.set_scene_label(2, None, "Test")["detail"])
        self.assertIn("color updated", device.set_scene_color(3, 0xFFFF02C2, "Test")["detail"])
        self.assertEqual(calls, [
            ("copy", 0, 1, False),
            ("label", 2, None),
            ("color", 3, 0xFFFF02C2),
        ])

        with self.assertRaisesRegex(ValueError, "different"):
            device.copy_scene(1, 1, False, "Test")
        with self.assertRaisesRegex(ValueError, "32"):
            device.set_scene_label(0, "x" * 33, "Test")
        with self.assertRaisesRegex(ValueError, "4294967295"):
            device.set_scene_color(0, 0x100000000, "Test")

    def test_python_adapter_rejects_invalid_values_before_device_io(self):
        device = PyQuadCortexDevice()
        device._qc = SimpleNamespace()
        with self.assertRaisesRegex(ValueError, "64 visible"):
            device.set_device_name("x" * 65)
        with self.assertRaisesRegex(ValueError, "0 through 255"):
            device.preset_screenshot("My Presets", 256)
        with self.assertRaisesRegex(ValueError, "x must satisfy"):
            device.tap_screen(800, 0)
        with self.assertRaisesRegex(RuntimeError, "does not provide capture_screen"):
            device.capture_screen()


class DeviceVisualTests(unittest.TestCase):
    def test_device_category_colors_match_grid_and_stomp_palette(self):
        self.assertEqual(_block_color("Utility", "Adaptive Gate"), "#959595")
        self.assertEqual(_block_color("Delay", "Analog Delay"), "#00ffdd")
        self.assertEqual(_block_color("Guitar Overdrive", "Rodent Drive"), "#ff7000")
        self.assertEqual(_stomp_color([{"category": "Utility", "name": "Adaptive Gate"}]), "#f4f4f4")
        self.assertEqual(_stomp_color([{"category": "Delay", "name": "Analog Delay"}]), "#00ffdd")
        self.assertEqual(_stomp_color([{"category": "Guitar Overdrive", "name": "Rodent Drive"}]), "#ffd236")

    def test_every_coros_4_1_category_has_the_official_stomp_color(self):
        categories = {
            "Plugins": "#ff7000",
            "Guitar Amplifier": "#ff2727",
            "Neural Capture": "#f4f4f4",
            "Guitar Cabinet": "#6954ff",
            "Guitar Overdrive": "#ffd236",
            "Delay": "#00ffdd",
            "Reverb": "#00ffdd",
            "Compressor": "#45f862",
            "Pitch": "#ffd236",
            "Modulation": "#3500f1",
            "Morph": "#87daff",
            "Synth": "#e44a5d",
            "Filter": "#87daff",
            "Equalizer": "#0a74e0",
            "IRLoaders": "#6954ff",
            "Wah": "#f4f4f4",
            "FX Loop": "#f4f4f4",
            "Loopers": "#ff2727",
            "Utility": "#f4f4f4",
        }
        for category, expected in categories.items():
            with self.subTest(category=category):
                self.assertEqual(_stomp_color([{"category": category, "name": category}]), expected)

    def test_every_catalog_value_shape_has_an_explicit_editor_state(self):
        self.assertEqual(_editor_parameter_state(0.25, [], "float"), (0.25, True))
        self.assertEqual(_editor_parameter_state(0.25, [], "grMeter"), (0.25, False))
        self.assertEqual(_editor_parameter_state("Ribbon 121", ["Dynamic 57", "Ribbon 121", "Condenser 414"], "string"), (0.5, True))
        self.assertEqual(_editor_parameter_state("missing", ["A", "B"], "string"), (None, False))
        self.assertEqual(_editor_parameter_state(False, ["OFF", "ON"], "switch"), (None, False))

    def test_live_catalog_audit_checks_every_visible_parameter(self):
        class Value:
            def __init__(self, index, name, kind, steps=None):
                self.index, self.name, self.type, self.steps = index, name, kind, steps

        class Model:
            hidden = internal = category_hidden = superseded = False
            id, name, category = 42, "Installed plugin", "Plugin"
            parameters = (Value(0, "GAIN", "float"), Value(1, "METER", "grMeter"))

        self.assertEqual(_catalog_audit([Model()]), {
            "modelCount": 1,
            "parameterCount": 2,
            "categoryCount": 1,
            "exceptions": [],
        })


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
        self.assertEqual(result["gatewayApiVersion"], GATEWAY_API_VERSION)
        self.assertIn("modelRepoParameterMetadata", result["capabilities"])
        self.assertNotIn("nativeBroker", result["capabilities"])
        self.assertIn("nativeStateEvents", result["capabilities"])
        self.assertIn("preset Save As", result["message"])
        self.assertIn("other persistent writes remain locked", result["message"])

    def test_reconnect_and_snapshot(self):
        self.assertEqual(self.request("device.reconnect")["result"]["phase"], "ready")
        self.assertEqual(self.request("device.snapshot")["result"]["presetName"], "Test")
        self.assertEqual(self.request("device.stateEvents", {"afterSequence": 10})["result"]["frames"][0]["sequence"], 11)
        self.assertEqual(self.request("device.tempoClock")["result"]["currentTick"], 1)
        self.assertEqual(self.request("device.disconnect")["result"]["phase"], "disconnected")

    def test_unknown_method_uses_json_rpc_error(self):
        self.assertEqual(self.request("device.mutate")["error"]["code"], -32601)

    def test_boolean_request_id_is_rejected(self):
        response = self.service.handle({"jsonrpc": "2.0", "id": True, "method": "system.status"})
        self.assertEqual(response["error"]["code"], -32600)

    def test_pyquadcortex_parity_methods_are_all_dispatched(self):
        identity = self.request("device.identity")["result"]
        name = self.request("device.setDeviceName", {"name": "Stage QC"})["result"]
        undo = self.request("device.undo")["result"]
        redo = self.request("device.redo")["result"]
        inhibited = self.request("device.inhibitedModules")["result"]
        preset = self.request("device.presetScreenshot", {
            "folderName": "Factory Library", "position": 12, "isFactory": True,
        })["result"]
        screen = self.request("device.captureScreen")["result"]
        tap = self.request("device.tapScreen", {"x": 320.5, "y": 200})["result"]
        self.assertEqual(identity["serial"], "fake-serial")
        self.assertEqual(name["detail"], "name Stage QC")
        self.assertEqual((undo["detail"], redo["detail"]), ("undo", "redo"))
        self.assertEqual(inhibited, {"globalGate": False, "globalEq": True})
        self.assertEqual(preset["target"], "Factory Library:12:True")
        self.assertEqual((screen["width"], screen["height"]), (800, 480))
        self.assertEqual(tap["detail"], "tap 320.5:200")

    def test_live_control_methods_are_dispatched_with_params(self):
        scene = self.request("device.selectScene", {"scene": 3, "expectedPresetName": "Test"})
        scene_copy = self.request("device.copyScene", {
            "fromScene": 1, "toScene": 2, "swap": True, "expectedPresetName": "Test"
        })
        scene_label = self.request("device.setSceneLabel", {
            "scene": 2, "label": None, "expectedPresetName": "Test"
        })
        scene_color = self.request("device.setSceneColor", {
            "scene": 2, "color": 0xFFFF02C2, "expectedPresetName": "Test"
        })
        bypass = self.request("device.toggleBypass", {
            "row": 2, "column": 4, "expectedScene": 3, "expectedBypassed": False,
            "desiredBypassed": True, "expectedPresetName": "Test"
        })
        moved = self.request("device.moveBlock", {
            "row": 2, "fromColumn": 4, "toColumn": 6,
            "expectedModelId": 123, "expectedPresetName": "Test"
        })
        models = self.request("device.listModels")
        added = self.request("device.addBlock", {
            "row": 1, "column": 3, "modelId": 123, "expectedPresetName": "Test"
        })
        removed = self.request("device.removeBlock", {
            "row": 1, "column": 3, "expectedModelId": 123, "expectedPresetName": "Test"
        })
        assigned = self.request("device.setBlockFootswitch", {
            "row": 2, "column": 6, "footswitch": 4,
            "expectedFootswitch": None, "expectedModelId": 123,
            "expectedPresetName": "Test"
        })
        input_route = self.request("device.setChainInput", {
            "row": 0, "inputId": 3, "expectedInputId": 1, "expectedPresetName": "Test"
        })
        output_route = self.request("device.setChainOutput", {
            "row": 0, "outputId": 19, "expectedOutputId": 4, "expectedPresetName": "Test"
        })
        split_route = self.request("device.setChainSplit", {
            "row": 0, "splitColumn": 2, "mixColumn": 6,
            "expectedSplitColumn": None, "expectedMixColumn": None,
            "expectedPresetName": "Test"
        })
        split_mute = self.request("device.setSplitMute", {
            "row": 0, "muted": True, "expectedMuted": False,
            "expectedPresetName": "Test"
        })
        tuner = self.request("device.showTuner", {"shown": True})
        gig = self.request("device.showGigView", {"shown": True})
        presets = self.request("device.listPresets", {"setlistKey": "custom"})
        preset_folders = self.request("device.listPresetFolders")
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
        preview = self.request("device.previewParameter", {
            "row": 0, "column": 1, "parameterIndex": 2,
            "value": 0.74, "expectedScene": 0, "expectedPresetName": "Test"
        })
        tempo = self.request("device.setTempo", {
            "bpm": 121, "expectedTempo": 120, "expectedPresetName": "Test"
        })
        volume = self.request("device.setMasterVolume", {
            "value": 57, "expectedValue": 56
        })
        live_volume = self.request("device.masterVolume")
        footswitch = self.request("device.pressFootswitch", {
            "index": 4, "expectedMode": "STOMP", "expectedPresetName": "Test"
        })
        mode_slot = self.request("device.selectModeSlot", {
            "slot": 2, "expectedPresetName": "Test"
        })
        slots = self.request("device.listPresetSlots")
        saved = self.request("device.savePresetAs", {
            "setlistKey": "fake", "position": 17, "name": "Copy",
            "expectedPresetName": "Test", "expectedPosition": 9,
            "confirmOverwrite": True
        })
        copied = self.request("device.copyPreset", {
            "sourceSetlistKey": "source", "sourcePosition": 1, "sourceName": "Source",
            "destinationSetlistKey": "fake", "destinationPosition": 9,
            "expectedPresetName": "Test", "expectedPosition": 9,
            "confirmOverwrite": True
        })
        renamed = self.request("device.renameCurrentPreset", {
            "name": "Renamed", "expectedPresetName": "Test", "expectedPosition": 9,
            "confirmRename": True
        })
        backup = self.request("device.createBackup", {"name": "Native copy"})
        self.assertEqual(scene["result"]["detail"], "scene 3")
        self.assertEqual(scene_copy["result"]["detail"], "scene-copy 1:2:True")
        self.assertEqual(scene_label["result"]["detail"], "scene-label 2:None")
        self.assertEqual(scene_color["result"]["detail"], "scene-color 2:4294902466")
        self.assertEqual(bypass["result"]["detail"], "bypass 2:4:3:False:True")
        self.assertEqual(moved["result"]["detail"], "move 2:4:6:123")
        self.assertEqual(models["result"]["models"][0]["name"], "Fake model")
        self.assertEqual(added["result"]["detail"], "add 1:3:123")
        self.assertEqual(removed["result"]["detail"], "remove 1:3:123")
        self.assertEqual(assigned["result"]["detail"], "assign 2:6:4:None:123")
        self.assertEqual(input_route["result"]["detail"], "input 0:3:1")
        self.assertEqual(output_route["result"]["detail"], "output 0:19:4")
        self.assertEqual(split_route["result"]["detail"], "split 0:2:6:None:None")
        self.assertEqual(split_mute["result"]["detail"], "split-mute 0:True:False")
        self.assertEqual(tuner["result"]["detail"], "tuner True")
        self.assertEqual(gig["result"]["detail"], "gig True")
        self.assertEqual(presets["result"]["setlistName"], "Fake")
        self.assertEqual(presets["result"]["setlistKey"], "custom")
        self.assertEqual(preset_folders["result"]["folders"][0]["name"], "Fake")
        self.assertEqual(bank["result"]["detail"], "bank 1:9")
        self.assertEqual(recall["result"]["detail"], "recall fake:17")
        self.assertEqual(reload["result"]["detail"], "reload 9")
        self.assertEqual(details["result"]["name"], "Fake block")
        self.assertEqual(parameter["result"]["detail"], "parameter 2:0.75")
        self.assertEqual(preview["result"]["detail"], "preview 2:0.74")
        self.assertEqual(tempo["result"]["detail"], "tempo 121:120")
        self.assertEqual(volume["result"]["detail"], "volume 57:56")
        self.assertEqual(live_volume["result"]["value"], 56)
        self.assertEqual(footswitch["result"]["detail"], "footswitch 4:STOMP")
        self.assertEqual(mode_slot["result"]["detail"], "mode-slot 2")
        self.assertEqual(slots["result"]["setlistName"], "Fake")
        self.assertEqual(saved["result"]["detail"], "save 17:Copy:True")
        self.assertEqual(copied["result"]["detail"], "copy source:1:fake:9:True")
        self.assertEqual(renamed["result"]["detail"], "rename 9:Renamed:True")
        self.assertEqual(backup["result"]["name"], "Native copy")
        self.assertEqual(backup["result"]["type"], "backup")


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
