from __future__ import annotations

import asyncio
import io
import inspect
import json
import struct
import sys
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "mcp-server" / "src"))
sys.path.insert(0, str(ROOT / "packages" / "python" / "qc-gateway-client" / "src"))

from qc_gateway_client import GatewayError, InProcessGatewayClient, StdioGatewayClient
from qc_gateway_client.client import _read_frame
from qc_mcp_server.generated_actions import MCP_INSTRUCTIONS, SHARED_QC_ACTIONS
from qc_mcp_server.generated_result_kinds import GATEWAY_RESULT_KINDS
from qc_mcp_server.server import QcTools, _validated_backend_result, create_mcp


class RecordingBackend:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
        payload = dict(params or {})
        self.calls.append((method, payload))
        result = {"method": method, "params": payload}
        if method == "device.snapshot":
            result.update({"presetName": "Clean", "blocks": []})
        if GATEWAY_RESULT_KINDS.get(method) == "DeviceActionResult":
            result.update({"detail": "accepted", "accepted": True, "verified": False,
                           "verification": "accepted_unverified"})
        return result

    def close(self) -> None:
        pass


class Service:
    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        if request["method"] == "device.snapshot":
            return {"jsonrpc": "2.0", "id": request["id"], "result": {"presetName": "Clean", "blocks": []}}
        return {"jsonrpc": "2.0", "id": request["id"], "error": {"code": -32010, "message": "No QC"}}


class GatewayClientTests(unittest.TestCase):
    def test_in_process_client_validates_envelope_and_surfaces_safe_error(self) -> None:
        client = InProcessGatewayClient(Service())
        self.assertEqual(client.request("device.snapshot"), {"presetName": "Clean", "blocks": []})
        with self.assertRaisesRegex(GatewayError, "No QC") as raised:
            client.request("system.status")
        self.assertEqual(raised.exception.code, -32010)

    def test_client_refuses_non_gateway_method_namespace(self) -> None:
        client = InProcessGatewayClient(Service())
        with self.assertRaises(ValueError):
            client.request("protobuf.write", {"payload": "anything"})
        with self.assertRaises(ValueError):
            client.request("device.unregisteredOperation")

    def test_windows_style_quoted_gateway_command_is_tokenized_for_popen(self) -> None:
        client = StdioGatewayClient.from_command_line('"C:\\Program Files\\QC Gateway.exe" --stdio')
        self.assertEqual(client.command, ("C:\\Program Files\\QC Gateway.exe", "--stdio"))

    def test_framed_client_accepts_partial_pipe_reads(self) -> None:
        payload = json.dumps({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}).encode()

        class PartialStream(io.BytesIO):
            def read(self, size: int = -1) -> bytes:
                return super().read(min(size, 2) if size >= 0 else 2)

        self.assertEqual(
            _read_frame(PartialStream(struct.pack(">I", len(payload)) + payload))["result"],
            {"ok": True},
        )

    def test_malformed_gateway_error_code_stays_a_gateway_error(self) -> None:
        class MalformedErrorService:
            def handle(self, request: dict[str, Any]) -> dict[str, Any]:
                return {"jsonrpc": "2.0", "id": request["id"], "error": {"code": "invalid", "message": "No QC"}}

        with self.assertRaises(GatewayError) as raised:
            InProcessGatewayClient(MalformedErrorService()).request("device.snapshot")
        self.assertEqual(raised.exception.code, -32000)

    def test_client_rejects_ambiguous_or_wrongly_typed_response_envelopes(self) -> None:
        class InvalidEnvelopeService:
            response: dict[str, Any]

            def handle(self, request: dict[str, Any]) -> dict[str, Any]:
                return {"jsonrpc": "2.0", "id": request["id"], **self.response}

        service = InvalidEnvelopeService()
        client = InProcessGatewayClient(service)
        for response in (
            {"result": {}, "error": {"code": -32010, "message": "ambiguous"}},
            {"error": "not-an-object"},
            {"result": {}, "extra": True},
        ):
            service.response = response
            with self.assertRaises(GatewayError):
                client.request("device.snapshot")

    def test_retryability_is_preserved_only_from_a_boolean_error_data_field(self) -> None:
        class ErrorService:
            retryable: object = True

            def handle(self, request: dict[str, Any]) -> dict[str, Any]:
                return {"jsonrpc": "2.0", "id": request["id"], "error": {
                    "code": -32010, "message": "No QC", "data": {"retryable": self.retryable}
                }}

        service = ErrorService()
        client = InProcessGatewayClient(service)
        with self.assertRaises(GatewayError) as raised:
            client.request("device.snapshot")
        self.assertTrue(raised.exception.retryable)
        service.retryable = "false"
        with self.assertRaises(GatewayError) as raised:
            client.request("device.snapshot")
        self.assertFalse(raised.exception.retryable)


class ToolSafetyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = RecordingBackend()
        self.tools = QcTools(self.backend)

    def test_backend_results_reject_contradictory_action_outcomes(self) -> None:
        valid = {"detail": "sent", "accepted": True, "verified": False,
                 "verification": "accepted_unverified"}
        self.assertIs(_validated_backend_result("device.showTuner", valid), valid)
        with self.assertRaisesRegex(RuntimeError, "malformed device action result"):
            _validated_backend_result("device.showTuner", {
                "detail": "sent", "accepted": True, "verified": False,
                "verification": "authoritative_readback",
            })

    def test_read_tools_map_to_versioned_gateway_methods(self) -> None:
        self.tools.get_current_preset()
        self.tools.get_block_details(1, 4, "Clean")
        self.tools.list_models(None)
        self.tools.list_presets(True, "factory")
        self.tools.list_preset_folders(True)
        self.tools.list_preset_slots()
        self.tools.get_master_volume()
        self.tools.get_tuner_settings()
        self.assertEqual([call[0] for call in self.backend.calls], [
            "device.snapshot", "device.blockDetails", "device.listModels", "device.listPresets",
            "device.listPresetFolders", "device.listPresetSlots", "device.masterVolume",
            "device.tunerSettings",
        ])

    def test_model_query_filters_locally_without_gateway_schema_drift(self) -> None:
        class ModelBackend(RecordingBackend):
            def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
                super().request(method, params)
                return {"models": [
                    {"id": 1, "name": "Vintage Delay", "category": "Delay"},
                    {"id": 2, "name": "Plini Lead", "category": "Plugin", "basedOn": "Archetype Plini"},
                ]}

        backend = ModelBackend()
        result = QcTools(backend).list_models("PLINI")
        self.assertEqual([model["id"] for model in result["models"]], [2])
        self.assertEqual(backend.calls, [("device.listModels", {})])

    def test_parameter_nodes_accept_routing_columns_but_blocks_do_not(self) -> None:
        for column in (8, 9):
            self.tools.get_block_details(0, column, "Clean")
            self.tools.preview_parameter(0, column, 0, .5, .4, 0, "Clean")
            self.tools.set_parameter(0, column, 0, .5, .4, 0, "Clean")
            self.tools.set_parameter_scene_mode(0, column, 0, True, "Clean")
            self.tools.set_parameter_expression(0, column, 0, 1, 0, 1, "Clean")
        with self.assertRaises(ValueError):
            self.tools.get_block_details(0, 10, "Clean")
        with self.assertRaises(ValueError):
            self.tools.set_bypass(0, 8, True, False, 0, "Clean")

    def test_python_boundary_rejects_fractional_indexes_and_nonfinite_values(self) -> None:
        with self.assertRaisesRegex(ValueError, "row must be an integer"):
            self.tools.set_bypass(1.5, 2, True, False, 0, "Clean")
        with self.assertRaisesRegex(ValueError, "parameter_index must be a non-negative integer"):
            self.tools.set_parameter(0, 0, 1.5, 0.5, 0.4, 0, "Clean")
        with self.assertRaisesRegex(ValueError, "normalized"):
            self.tools.set_parameter(0, 0, 1, float("nan"), 0.4, 0, "Clean")
        with self.assertRaisesRegex(ValueError, "expected_scene must be an integer"):
            self.tools.set_parameter(0, 0, 1, 0.5, 0.4, 1.5, "Clean")
        with self.assertRaisesRegex(ValueError, "after_sequence must be a non-negative integer"):
            self.tools.get_state_events(1.5, 10)
        with self.assertRaisesRegex(ValueError, "index must be an integer"):
            self.tools.press_footswitch(1.5, "STOMP", "Clean")
        with self.assertRaisesRegex(ValueError, "value must be an integer"):
            self.tools.set_master_volume(50.5, 50, True)
        calls = len(self.backend.calls)
        for invoke in (
            lambda: self.tools.show_tuner(1),
            lambda: self.tools.list_presets(1, None),
            lambda: self.tools.set_midi_thru(1, True),
            lambda: self.tools.set_input_port(1, float("inf"), None, None, None, True),
            lambda: self.tools.set_global_bypass([True, False, True, 0], [False] * 4, True),
        ):
            with self.assertRaises(ValueError):
                invoke()
        self.assertEqual(len(self.backend.calls), calls)

    def test_tap_screen_requires_integer_pixel_coordinates(self) -> None:
        with self.assertRaises(ValueError):
            self.tools.tap_screen(1.5, 2, True)
        with self.assertRaises(ValueError):
            self.tools.tap_screen(1, 2.5, True)
        self.tools.tap_screen(799, 479, True)
        self.assertEqual(self.backend.calls[-1], ("device.tapScreen", {"x": 799, "y": 479}))

    def test_backend_errors_preserve_code_message_and_retryability(self) -> None:
        class FailingBackend(RecordingBackend):
            def request(self, method: str, params: dict[str, Any] | None = None) -> Any:
                raise GatewayError("USB disconnected", code=-32010, retryable=True)

        with self.assertRaises(RuntimeError) as raised:
            QcTools(FailingBackend()).get_current_preset()
        self.assertEqual(json.loads(str(raised.exception)), {
            "code": -32010, "message": "USB disconnected", "retryable": True,
        })

    def test_capture_and_ir_loads_forward_nullable_cell_guards(self) -> None:
        self.tools.load_capture(1, 2, "capture/key", "Crunch", None, None, "Lead")
        self.tools.load_ir(2, 3, "ir/key", "Room", 1, 29_001, 14_000, "Lead")
        self.assertEqual(self.backend.calls, [
            ("device.loadCapture", {
                "row": 1, "column": 2, "key": "capture/key", "name": "Crunch",
                "modelId": None, "expectedModelId": None, "expectedPresetName": "Lead",
            }),
            ("device.loadIr", {
                "row": 2, "column": 3, "key": "ir/key", "name": "Room", "slot": 1,
                "modelId": 29_001, "expectedModelId": 14_000, "expectedPresetName": "Lead",
            }),
        ])

    def test_tuner_writes_require_both_explicit_confirmations(self) -> None:
        with self.assertRaises(ValueError):
            self.tools.set_tuner_mute(True, True, False)
        self.tools.set_tuner_input(8, True, True)
        self.tools.set_tuner_mute(False, True, True)
        self.tools.restore_tuner_audio(True, True)
        self.tools.set_tuner_reference(2.0, True, True)
        self.assertEqual([call[0] for call in self.backend.calls], [
            "device.setTunerInput",
            "device.setTunerMute",
            "device.restoreTunerAudio",
            "device.setTunerReference",
        ])

    def test_temporary_mutation_keeps_all_expected_state_guards(self) -> None:
        self.tools.set_parameter(2, 3, 7, 0.75, 0.5, 4, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setParameter", {
            "row": 2,
            "column": 3,
            "parameterIndex": 7,
            "value": 0.75,
            "expectedValue": 0.5,
            "expectedScene": 4,
            "expectedPresetName": "Lead",
        }))

        self.tools.set_parameter_scene_mode(2, 3, 7, True, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setParameterSceneMode", {
            "row": 2, "column": 3, "parameterIndex": 7, "enabled": True,
            "expectedPresetName": "Lead",
        }))

        self.tools.set_parameter_expression(2, 3, 7, 2, 0.8, 0.2, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setParameterExpression", {
            "row": 2, "column": 3, "parameterIndex": 7, "pedal": 2,
            "minimum": 0.8, "maximum": 0.2, "expectedPresetName": "Lead",
        }))

        self.tools.set_expression_bypass(2, 3, 1, 2, True, 250, False, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setExpressionBypass", {
            "row": 2, "column": 3, "pedal": 1, "mode": 2, "invert": True,
            "delayMs": 250, "latchEmulation": False, "expectedPresetName": "Lead",
        }))

        self.tools.set_stomp_momentary(4, True, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setStompMomentary", {
            "footswitch": 4, "momentary": True, "expectedPresetName": "Lead",
        }))

        self.tools.set_stomp_label(4, "Solo", "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setStompLabel", {
            "footswitch": 4, "label": "Solo", "expectedPresetName": "Lead",
        }))

        midi = [{"type": 1, "channel": 3, "param1": 10, "param2": 5, "param3": 120}]
        self.tools.set_midi_out(8, midi, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setMidiOut", {
            "source": 8, "messages": midi, "expectedPresetName": "Lead",
        }))
        self.tools.set_preset_load_midi_out(midi, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setPresetLoadMidiOut", {
            "messages": midi, "expectedPresetName": "Lead",
        }))

        self.tools.navigate_bank(-1, "Lead", 42)
        self.assertEqual(self.backend.calls[-1], ("device.navigateBank", {
            "direction": -1,
            "expectedPresetName": "Lead",
            "expectedPosition": 42,
        }))

        self.tools.select_mode_slot(2, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.selectModeSlot", {
            "slot": 2,
            "expectedPresetName": "Lead",
        }))

        self.tools.tap_tempo("STOMP", "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.tapTempo", {
            "expectedMode": "STOMP",
            "expectedPresetName": "Lead",
        }))

        self.tools.move_block(1, 2, 3, 101, "Lead")
        self.assertEqual(self.backend.calls[-1][0], "device.moveBlock")
        self.assertEqual(self.backend.calls[-1][1]["expectedModelId"], 101)

        self.tools.set_chain_split(0, None, None, 2, -1, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setChainSplit", {
            "row": 0, "splitColumn": None, "mixColumn": None,
            "expectedSplitColumn": 2, "expectedMixColumn": -1,
            "expectedPresetName": "Lead",
        }))

        self.tools.set_split_mute(2, True, False, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setSplitMute", {
            "row": 2,
            "muted": True,
            "expectedMuted": False,
            "expectedPresetName": "Lead",
        }))

        self.tools.copy_scene(1, 6, True, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.copyScene", {
            "fromScene": 1, "toScene": 6, "swap": True,
            "expectedPresetName": "Lead",
        }))

        self.tools.set_scene_label(6, None, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setSceneLabel", {
            "scene": 6, "label": None, "expectedPresetName": "Lead",
        }))

        self.tools.set_scene_color(6, 0xFFFF02C2, "Lead")
        self.assertEqual(self.backend.calls[-1], ("device.setSceneColor", {
            "scene": 6, "color": 0xFFFF02C2, "expectedPresetName": "Lead",
        }))

    def test_missing_or_invalid_expected_state_never_reaches_backend(self) -> None:
        with self.assertRaises(ValueError):
            self.tools.select_scene(2, "")
        with self.assertRaises(ValueError):
            self.tools.set_tempo(300, 120, "Clean")
        with self.assertRaises(ValueError):
            self.tools.set_bypass(4, 0, True, False, 0, "Clean")
        with self.assertRaises(ValueError):
            self.tools.copy_scene(2, 2, False, "Clean")
        with self.assertRaises(ValueError):
            self.tools.set_scene_label(2, "bad\nlabel", "Clean")
        with self.assertRaises(ValueError):
            self.tools.set_scene_color(2, 0x100000000, "Clean")
        with self.assertRaisesRegex(ValueError, "confirm_risky_operation"):
            self.tools.set_master_volume(60, 50, False)
        with self.assertRaisesRegex(ValueError, "confirm_risky_operation"):
            self.tools.reload_preset("Clean", 4, False)
        self.assertEqual(self.backend.calls, [])

    def test_persistent_save_has_separate_double_confirmation_gate(self) -> None:
        with self.assertRaisesRegex(ValueError, "confirm_persistent_write"):
            self.tools.save_preset_as("user", 20, "Copy", "Clean", 4, True, False)
        self.assertEqual(self.backend.calls, [])

        self.tools.save_preset_as("user", 20, "Copy", "Clean", 4, True, True)
        self.assertEqual(self.backend.calls[-1][0], "device.savePresetAs")
        self.assertTrue(self.backend.calls[-1][1]["confirmOverwrite"])

        with self.assertRaisesRegex(ValueError, "confirm_persistent_write"):
            self.tools.rename_current_preset("New name", "Clean", 4, False)
        self.tools.rename_current_preset("New name", "Clean", 4, True)
        self.assertEqual(self.backend.calls[-1][0], "device.renameCurrentPreset")
        self.assertTrue(self.backend.calls[-1][1]["confirmRename"])

        with self.assertRaisesRegex(ValueError, "confirm_persistent_write"):
            self.tools.copy_preset("user", 1, "Clean", "user", 2, "Clean", 1, True, False)
        self.tools.copy_preset("user", 1, "Clean", "user", 2, "Clean", 1, True, True)
        self.assertEqual(self.backend.calls[-1][0], "device.copyPreset")
        self.assertTrue(self.backend.calls[-1][1]["confirmOverwrite"])

    def test_general_settings_actions_share_the_persistent_confirmation_gate(self) -> None:
        self.tools.get_general_settings()
        self.assertEqual(self.backend.calls[-1], ("device.generalSettings", {}))

        mutations = [
            (self.tools.set_general_integer, ("holdTiming", 4, True),
             ("device.setGeneralInteger", {"setting": "holdTiming", "value": 4})),
            (self.tools.set_general_toggle, ("stompModeAutoAssign", False, True),
             ("device.setGeneralToggle", {"setting": "stompModeAutoAssign", "enabled": False})),
            (self.tools.set_scene_bypass_behavior, ("neverOverwrite", True),
             ("device.setSceneBypassBehavior", {"behavior": "neverOverwrite"})),
            (self.tools.set_master_volume_assignment, (True, False, True, False, True),
             ("device.setMasterVolumeAssignment", {
                 "out12": True, "out34": False, "send12": True, "headphones": False,
             })),
            (self.tools.set_global_bypass, ([True, False, True, False], [False, True, False, True], True),
             ("device.setGlobalBypass", {
                 "cab": [True, False, True, False], "ir": [False, True, False, True],
             })),
        ]
        for method, arguments, expected in mutations:
            method(*arguments)
            self.assertEqual(self.backend.calls[-1], expected)
            with self.assertRaisesRegex(ValueError, "confirm_persistent_write"):
                method(*arguments[:-1], False)

    def test_io_actions_share_the_persistent_confirmation_gate(self) -> None:
        self.tools.get_io_settings()
        self.assertEqual(self.backend.calls[-1], ("device.ioSettings", {}))

        mutations = [
            (self.tools.set_input_port, (1, 12.0, None, 1.0, None, True),
             ("device.setInputPort", {"inputPortId": 1, "levelDb": 12.0,
                                      "impedance": None, "inputType": 1.0, "groundLift": None})),
            (self.tools.set_output_port, (4, .75, None, False, True),
             ("device.setOutputPort", {"outputPortId": 4, "level": .75,
                                       "groundLift": None, "mute": False})),
            (self.tools.set_usb_port, (.25, None, 1.0, True),
             ("device.setUsbPort", {"level": .25, "headphonesSource": None, "dryWet": 1.0})),
            (self.tools.set_midi_thru, (True, True),
             ("device.setMidiThru", {"enabled": True})),
            (self.tools.set_output_pairing, (True, None, True),
             ("device.setOutputPairing", {"xlr12Linked": True, "out34Linked": None})),
        ]
        for method, arguments, expected in mutations:
            method(*arguments)
            self.assertEqual(self.backend.calls[-1], expected)
            with self.assertRaisesRegex(ValueError, "confirm_persistent_write"):
                method(*arguments[:-1], False)


class McpSurfaceTests(unittest.TestCase):
    @staticmethod
    def _sample(kind: str, name: str) -> Any:
        if name.startswith("confirm_"):
            return True
        if kind.startswith("nullable-"):
            return None
        return {
            "boolean": True,
            "boolean-row-array": [False, False, False, False],
            "bypass-delay": 0,
            "expression-switch-mode": 0,
            "general-integer-setting": "screenBrightness",
            "general-toggle-setting": "midiOverUsb",
            "global-eq-filter": 0,
            "grid-column": 0,
            "grid-row": 0,
            "integer": 0,
            "io-input-port": 1,
            "io-output-port": 1,
            "lane-control": "inputGate",
            "looper-command": "open",
            "midi-message-array": [],
            "mode-cycle": [0],
            "number": 0.5,
            "parameter-column": 0,
            "pedal": 1,
            "scene-bypass-behavior": "alwaysOverwrite",
            "scene-index": 0,
            "screen-x": 0,
            "screen-y": 0,
            "string": "Test",
            "tempo": 120,
            "tempo-mode": "PRESET",
        }[kind]

    def test_python_callable_signatures_match_all_contract_properties(self) -> None:
        contract = json.loads((ROOT / "contracts" / "qc-actions.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(MCP_INSTRUCTIONS, contract["mcpInstructions"])
        for action in contract["actions"]:
            signature = inspect.signature(getattr(QcTools, action["name"]))
            parameters = [value for name, value in signature.parameters.items() if name != "self"]
            self.assertEqual([value.name for value in parameters], list(action["properties"]), action["name"])
            required = {value.name for value in parameters if value.default is inspect.Parameter.empty}
            self.assertEqual(required, set(action["required"]), action["name"])

    def test_every_python_tool_emits_exactly_the_canonical_gateway_arguments(self) -> None:
        contract = json.loads((ROOT / "contracts" / "qc-actions.v1.json").read_text(encoding="utf-8"))
        backend = RecordingBackend()
        tools = QcTools(backend)
        for action in contract["actions"]:
            arguments = []
            for name, kind in action["properties"].items():
                value = self._sample(kind, name)
                if action["name"] == "navigate_bank" and name == "direction":
                    value = 1
                elif action["name"] == "copy_scene" and name == "to_scene":
                    value = 1
                elif name in ("input_port_id", "output_port_id", "band", "limit"):
                    value = 1
                arguments.append(value)
            try:
                getattr(tools, action["name"])(*arguments)
            except Exception as error:
                self.fail(f"{action['name']} did not map its canonical arguments: {error}")

    def test_server_publishes_only_intent_level_tools_and_resources(self) -> None:
        server = create_mcp(RecordingBackend())
        tools = asyncio.run(server.list_tools())
        names = {tool.name for tool in tools}
        self.assertEqual(names, set(SHARED_QC_ACTIONS))
        self.assertFalse(any("raw" in name or "protobuf" in name for name in names))
        by_name = {tool.name: tool for tool in tools}
        self.assertEqual(by_name["set_tempo"].description, SHARED_QC_ACTIONS["set_tempo"]["description"])
        self.assertTrue(by_name["get_current_preset"].annotations.read_only_hint)
        self.assertTrue(by_name["get_current_preset"].annotations.idempotent_hint)
        self.assertFalse(by_name["set_parameter"].annotations.destructive_hint)
        self.assertTrue(by_name["save_preset_as"].annotations.destructive_hint)
        self.assertTrue(by_name["rename_current_preset"].annotations.destructive_hint)
        self.assertTrue(by_name["set_master_volume"].annotations.destructive_hint)
        self.assertTrue(by_name["reload_preset"].annotations.destructive_hint)
        self.assertTrue(by_name["copy_preset"].annotations.destructive_hint)

        resources = asyncio.run(server.list_resources())
        self.assertEqual({str(resource.uri) for resource in resources}, {
            "qc://status", "qc://current-preset", "qc://models"
        })

    def test_resource_returns_structured_gateway_state_as_json(self) -> None:
        backend = RecordingBackend()
        server = create_mcp(backend)
        result = asyncio.run(server.read_resource("qc://current-preset"))
        # MCPServer v2 returns resource content objects; verify their textual payload.
        payload = next(item.content for item in result if isinstance(item.content, str))
        self.assertEqual(json.loads(payload)["method"], "device.snapshot")


if __name__ == "__main__":
    unittest.main()
