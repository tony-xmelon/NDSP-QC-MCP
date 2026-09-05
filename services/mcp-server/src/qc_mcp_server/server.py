"""MCP resources and typed tools for safe Quad Cortex control."""

from __future__ import annotations

import json
import math
from collections.abc import Mapping
from typing import Any, Literal

from mcp.server import MCPServer
from mcp.types import ToolAnnotations

from .backend import QcBackend
from .generated_actions import (
    MCP_GATEWAY_ARGUMENTS,
    MCP_GATEWAY_SCHEMAS,
    MCP_INSTRUCTIONS,
    SHARED_QC_ACTIONS,
)
from .generated_result_kinds import GATEWAY_RESULT_KINDS
from .generated_domain import (
    GRID_COLUMNS,
    GRID_ROWS,
    IPC_MAX_FRAME_BYTES,
    MAXIMUM_TEMPO_BPM,
    MINIMUM_TEMPO_BPM,
    SCENE_COUNT,
)


def _validated_backend_result(method: str, result: Any) -> Any:
    try:
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise RuntimeError(f"{method} returned a non-JSON result") from error
    if len(encoded) > IPC_MAX_FRAME_BYTES:
        raise RuntimeError(f"{method} returned a result larger than the gateway frame limit")
    kind = GATEWAY_RESULT_KINDS.get(method)
    if kind is None:
        raise RuntimeError(f"Unknown gateway result contract: {method}")
    if not isinstance(result, Mapping):
        raise RuntimeError(f"{method} returned a malformed {kind} result")
    if kind == "PresetSnapshot" and (
        not isinstance(result.get("presetName"), str) or not isinstance(result.get("blocks"), list)
    ):
        raise RuntimeError(f"{method} returned a malformed PresetSnapshot result")
    if kind == "DeviceActionResult" and not any(
        key in result for key in ("accepted", "verified", "verification")
    ):
        raise RuntimeError(f"{method} returned a device action result without verification semantics")
    if isinstance(result, Mapping) and any(key in result for key in ("accepted", "verified", "verification")):
        verified = result.get("verified")
        expected = "authoritative_readback" if verified is True else "accepted_unverified"
        if (
            result.get("accepted") is not True
            or not isinstance(verified, bool)
            or result.get("verification") != expected
            or not isinstance(result.get("detail"), str)
            or len(result["detail"]) > 4096
        ):
            raise RuntimeError(f"{method} returned a malformed device action result")
    return result


def _required_text(value: str, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string.")
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{label} is required and must come from a fresh device snapshot.")
    return cleaned


def _grid_cell(row: int, column: int) -> None:
    if isinstance(row, bool) or not isinstance(row, int) or not 0 <= row < GRID_ROWS:
        raise ValueError(f"row must be an integer from 0 through {GRID_ROWS - 1}")
    if isinstance(column, bool) or not isinstance(column, int) or not 0 <= column < GRID_COLUMNS:
        raise ValueError(f"column must be an integer from 0 through {GRID_COLUMNS - 1}")


def _parameter_cell(row: int, column: int) -> None:
    if isinstance(row, bool) or not isinstance(row, int) or not 0 <= row < GRID_ROWS:
        raise ValueError(f"row must be an integer from 0 through {GRID_ROWS - 1}")
    if isinstance(column, bool) or not isinstance(column, int) or not 0 <= column <= GRID_COLUMNS + 1:
        raise ValueError(f"column must be an integer from 0 through {GRID_COLUMNS + 1}")


def _parameter_args(
    row: int, column: int, parameter_index: int, value: float,
    expected_value: float, expected_scene: int, expected_preset_name: str,
) -> dict[str, Any]:
    _parameter_cell(row, column)
    if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
        raise ValueError("parameter_index must be a non-negative integer")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0.0 <= value <= 1.0:
        raise ValueError("value must be normalized from 0.0 through 1.0")
    if isinstance(expected_value, bool) or not isinstance(expected_value, (int, float)) or not math.isfinite(expected_value) or not 0.0 <= expected_value <= 1.0:
        raise ValueError("expected_value must be normalized from 0.0 through 1.0")
    if isinstance(expected_scene, bool) or not isinstance(expected_scene, int) or not 0 <= expected_scene < SCENE_COUNT:
        raise ValueError(f"expected_scene must be an integer from 0 through {SCENE_COUNT - 1}")
    return {
        "row": row, "column": column, "parameterIndex": parameter_index,
        "value": float(value), "expectedValue": float(expected_value),
        "expectedScene": expected_scene,
        "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
    }


def _midi_messages(messages: list[dict[str, int]]) -> list[dict[str, int]]:
    if not isinstance(messages, list) or len(messages) > 12:
        raise ValueError("messages must be a list containing at most 12 MIDI messages")
    limits = {"type": (1, 3), "channel": (1, 16), "param1": (0, 127), "param2": (0, 127), "param3": (0, 127)}
    normalized = []
    for message in messages:
        if not isinstance(message, Mapping) or set(message) != set(limits):
            raise ValueError("each MIDI message must contain only type, channel, param1, param2, and param3")
        current = {}
        for field, (minimum, maximum) in limits.items():
            value = message[field]
            if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                raise ValueError(f"MIDI {field} must be an integer from {minimum} through {maximum}")
            current[field] = value
        normalized.append(current)
    return normalized


def _matches_schema(value: Any, schema: dict[str, Any]) -> bool:
    expected = schema.get("type")
    types = expected if isinstance(expected, list) else [expected]
    matches_type = any(
        (kind == "null" and value is None)
        or (kind == "boolean" and isinstance(value, bool))
        or (kind == "integer" and isinstance(value, int) and not isinstance(value, bool))
        or (kind == "number" and isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value))
        or (kind == "string" and isinstance(value, str))
        or (kind == "array" and isinstance(value, list))
        or (kind == "object" and isinstance(value, Mapping))
        for kind in types
    )
    if not matches_type or value is None:
        return matches_type
    if "enum" in schema and value not in schema["enum"]:
        return False
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if "minimum" in schema and value < schema["minimum"]:
            return False
        if "maximum" in schema and value > schema["maximum"]:
            return False
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
            return False
        if schema.get("pattern") and any(ord(character) < 32 or ord(character) == 127 for character in value):
            return False
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
            return False
        if schema.get("uniqueItems") and len({json.dumps(item, sort_keys=True) for item in value}) != len(value):
            return False
        if "items" in schema and not all(_matches_schema(item, schema["items"]) for item in value):
            return False
    if isinstance(value, Mapping):
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False and set(value) - set(properties):
            return False
        if set(schema.get("required", ())) - set(value):
            return False
        if any(name in value and not _matches_schema(value[name], child) for name, child in properties.items()):
            return False
    return True


class QcTools:
    """Testable application adapter; every mutation maps to one allowlisted method."""

    def __init__(self, backend: QcBackend) -> None:
        self.backend = backend

    def _request(self, action: str, params: dict[str, Any] | None = None) -> Any:
        payload = dict(params or {})
        expected = set(MCP_GATEWAY_ARGUMENTS[action])
        if set(payload) != expected:
            missing = sorted(expected - set(payload))
            unexpected = sorted(set(payload) - expected)
            raise RuntimeError(f"MCP gateway argument drift for {action}: missing={missing}, unexpected={unexpected}")
        for name, schema in MCP_GATEWAY_SCHEMAS[action].items():
            if not _matches_schema(payload[name], schema):
                raise ValueError(f"{name} does not match the canonical schema for {action}")
        try:
            method = SHARED_QC_ACTIONS[action]["rpc"]
            return _validated_backend_result(method, self.backend.request(method, payload))
        except Exception as error:
            code = getattr(error, "code", None)
            if code is None:
                raise
            detail = {
                "code": code,
                "message": str(error),
                "retryable": bool(getattr(error, "retryable", False)),
            }
            raise RuntimeError(json.dumps(detail, separators=(",", ":"))) from error

    def get_current_preset(self) -> Any:
        """Read the authoritative current preset, scene, blocks, tempo and dirty state."""
        return self._request("get_current_preset")

    def get_status(self) -> Any:
        """Read gateway availability and connection capabilities."""
        return _validated_backend_result("system.status", self.backend.request("system.status"))

    def reconnect_device(self, confirm_risky_operation: bool) -> Any:
        """Reconnect the native device session after explicit confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Reconnect requires confirm_risky_operation=true.")
        return self._request("reconnect_device")

    def reset_device_session(self, confirm_risky_operation: bool) -> Any:
        """Reset and re-synchronize the native device session."""
        if confirm_risky_operation is not True:
            raise ValueError("Session reset requires confirm_risky_operation=true.")
        return self._request("reset_device_session")

    def disconnect_device(self, confirm_risky_operation: bool) -> Any:
        """Disconnect the native device session after explicit confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Disconnect requires confirm_risky_operation=true.")
        return self._request("disconnect_device")

    def get_device_identity(self) -> Any:
        """Read the connected device identity and custom name."""
        return self._request("get_device_identity")

    def get_state_events(self, after_sequence: int, limit: int) -> Any:
        """Read native state frames after a sequence cursor."""
        if isinstance(after_sequence, bool) or not isinstance(after_sequence, int) or after_sequence < 0:
            raise ValueError("after_sequence must be a non-negative integer")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 4096:
            raise ValueError("limit must be an integer from 1 through 4096")
        return self._request("get_state_events", {
            "afterSequence": after_sequence, "limit": limit,
        })

    def get_tempo_clock(self) -> Any:
        """Read the latest native metronome clock state."""
        return self._request("get_tempo_clock")

    def get_inhibited_modules(self) -> Any:
        """Read the device's compiler-inhibited Global Gate and EQ state."""
        return self._request("get_inhibited_modules")

    def get_tuner_settings(self) -> Any:
        """Read tuner preferences without changing or engaging the tuner."""
        return self._request("get_tuner_settings")

    def set_tuner_input(
        self, input_port_id: int, confirm_tuner_activation: bool,
        confirm_risky_operation: bool,
    ) -> Any:
        """Select a tuner input after acknowledging invisible tuner engagement."""
        if confirm_tuner_activation is not True or confirm_risky_operation is not True:
            raise ValueError("Tuner input changes require both explicit confirmations.")
        return self._request("set_tuner_input", {
            "inputPortId": input_port_id,
            "confirmTunerActivation": True,
        })

    def set_tuner_mute(
        self, muted: bool, confirm_tuner_activation: bool,
        confirm_risky_operation: bool,
    ) -> Any:
        """Change mute-while-tuning after acknowledging that it can silence the rig."""
        if confirm_tuner_activation is not True or confirm_risky_operation is not True:
            raise ValueError("Tuner mute changes require both explicit confirmations.")
        return self._request("set_tuner_mute", {
            "muted": muted,
            "confirmTunerActivation": True,
        })

    def restore_tuner_audio(
        self, confirm_preference_reset: bool, confirm_risky_operation: bool,
    ) -> Any:
        """Clear mute-while-tuning after acknowledging the persistent preference reset."""
        if confirm_preference_reset is not True or confirm_risky_operation is not True:
            raise ValueError("Restoring tuner audio requires both explicit confirmations.")
        return self._request("restore_tuner_audio", {
            "confirmPreferenceReset": True,
        })

    def set_tuner_reference(
        self, reference_offset_hz: float, confirm_tuner_activation: bool,
        confirm_risky_operation: bool,
    ) -> Any:
        """Set the Hz offset from 440 after acknowledging invisible engagement."""
        if confirm_tuner_activation is not True or confirm_risky_operation is not True:
            raise ValueError("Tuner reference changes require both explicit confirmations.")
        return self._request("set_tuner_reference", {
            "referenceOffsetHz": reference_offset_hz,
            "confirmTunerActivation": True,
        })

    def get_general_settings(self) -> Any:
        """Read global Quad Cortex Device Settings."""
        return self._request("get_general_settings")

    def get_io_settings(self) -> Any:
        """Read all Quad Cortex input, output, USB, MIDI and expression-port settings."""
        return self._request("get_io_settings")

    def set_input_port(self, input_port_id: int, level_db: float | None,
                       impedance: float | None, input_type: float | None,
                       ground_lift: float | None, confirm_persistent_write: bool) -> Any:
        """Sparsely update one input port after explicit confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing I/O settings requires confirm_persistent_write=true.")
        return self._request("set_input_port", {
            "inputPortId": input_port_id, "levelDb": level_db,
            "impedance": impedance, "inputType": input_type, "groundLift": ground_lift,
        })

    def set_output_port(self, output_port_id: int, level: float | None,
                        ground_lift: float | None, mute: bool | None,
                        confirm_persistent_write: bool) -> Any:
        """Sparsely update one output port after explicit confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing I/O settings requires confirm_persistent_write=true.")
        return self._request("set_output_port", {
            "outputPortId": output_port_id, "level": level,
            "groundLift": ground_lift, "mute": mute,
        })

    def set_usb_port(self, level: float | None, headphones_source: float | None,
                     dry_wet: float | None, confirm_persistent_write: bool) -> Any:
        """Sparsely update USB audio settings after explicit confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing I/O settings requires confirm_persistent_write=true.")
        return self._request("set_usb_port", {
            "level": level, "headphonesSource": headphones_source, "dryWet": dry_wet,
        })

    def set_midi_thru(self, enabled: bool, confirm_persistent_write: bool) -> Any:
        """Set MIDI Thru after explicit confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing I/O settings requires confirm_persistent_write=true.")
        return self._request("set_midi_thru", {"enabled": enabled})

    def set_output_pairing(self, xlr12_linked: bool | None, out34_linked: bool | None,
                           confirm_persistent_write: bool) -> Any:
        """Pair or unpair output couples after explicit confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing I/O settings requires confirm_persistent_write=true.")
        return self._request("set_output_pairing", {
            "xlr12Linked": xlr12_linked, "out34Linked": out34_linked,
        })

    def set_general_integer(self, setting: str, value: int, confirm_persistent_write: bool) -> Any:
        """Set one validated integer Device Setting."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing device settings requires confirm_persistent_write=true.")
        return self._request("set_general_integer", {"setting": setting, "value": value})

    def set_general_toggle(self, setting: str, enabled: bool, confirm_persistent_write: bool) -> Any:
        """Set one validated boolean Device Setting."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing device settings requires confirm_persistent_write=true.")
        return self._request("set_general_toggle", {"setting": setting, "enabled": enabled})

    def set_scene_bypass_behavior(self, behavior: str, confirm_persistent_write: bool) -> Any:
        """Set global scene bypass persistence behavior."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing device settings requires confirm_persistent_write=true.")
        return self._request("set_scene_bypass_behavior", {"behavior": behavior})

    def set_master_volume_assignment(self, out12: bool, out34: bool, send12: bool,
                                     headphones: bool, confirm_persistent_write: bool) -> Any:
        """Replace all Master Volume output assignments."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing device settings requires confirm_persistent_write=true.")
        return self._request("set_master_volume_assignment", {
            "out12": out12, "out34": out34, "send12": send12, "headphones": headphones,
        })

    def set_global_bypass(self, cab: list[bool], ir: list[bool],
                          confirm_persistent_write: bool) -> Any:
        """Replace all Cab and IR global bypass rows."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing device settings requires confirm_persistent_write=true.")
        return self._request("set_global_bypass", {"cab": cab, "ir": ir})

    def get_preset_screenshot(
        self, folder_name: str, position: int, is_factory: bool
    ) -> Any:
        """Read a device-rendered preset screenshot without recalling it."""
        if isinstance(position, bool) or not isinstance(position, int) or position < 0:
            raise ValueError("position must be a non-negative integer")
        return self._request("get_preset_screenshot", {
            "folderName": _required_text(folder_name, "folder_name"),
            "position": position,
            "isFactory": is_factory,
        })

    def capture_screen(self) -> Any:
        """Capture the current physical Quad Cortex display."""
        return self._request("capture_screen")

    def set_device_name(self, name: str, confirm_persistent_write: bool) -> Any:
        """Change the device name after explicit persistent-write confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Changing the device name requires confirm_persistent_write=true.")
        if not isinstance(name, str):
            raise ValueError("name must be a string")
        return self._request("set_device_name", {"name": name})

    def undo_device(self, confirm_risky_operation: bool) -> Any:
        """Undo the latest on-device edit after explicit confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Device undo requires confirm_risky_operation=true.")
        return self._request("undo_device")

    def redo_device(self, confirm_risky_operation: bool) -> Any:
        """Redo the latest on-device edit after explicit confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Device redo requires confirm_risky_operation=true.")
        return self._request("redo_device")

    def tap_screen(self, x: int, y: int, confirm_risky_operation: bool) -> Any:
        """Tap one reviewed physical-screen coordinate after explicit confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Screen taps require confirm_risky_operation=true.")
        if isinstance(x, bool) or not isinstance(x, int) or not 0 <= x < 800:
            raise ValueError("x must be an integer pixel coordinate from 0 through 799")
        if isinstance(y, bool) or not isinstance(y, int) or not 0 <= y < 480:
            raise ValueError("y must be an integer pixel coordinate from 0 through 479")
        return self._request("tap_screen", {"x": x, "y": y})

    def list_models(self, query: str | None) -> Any:
        """List device models installed and available on the connected Quad Cortex."""
        if query is not None and not isinstance(query, str):
            raise ValueError("query must be a string or null")
        result = self._request("list_models")
        needle = (query or "").strip().casefold()
        if not needle:
            return result
        if not isinstance(result, Mapping) or not isinstance(result.get("models"), list):
            raise RuntimeError("device.listModels returned a malformed response")
        filtered = dict(result)
        filtered["models"] = [model for model in result["models"] if isinstance(model, Mapping) and any(
            needle in str(model.get(field, "")).casefold() for field in ("name", "category", "basedOn")
        )]
        return filtered

    def list_presets(self, refresh: bool, setlist_key: str | None) -> Any:
        """List presets, optionally refreshing the device index or restricting a setlist."""
        params: dict[str, Any] = {"refresh": refresh, "setlistKey": setlist_key}
        return self._request("list_presets", params)

    def list_preset_folders(self, refresh: bool) -> Any:
        """List the device's preset folders and setlists."""
        return self._request("list_preset_folders", {"refresh": refresh})

    def list_preset_slots(self) -> Any:
        """List preset destinations with occupancy information for safe writes."""
        return self._request("list_preset_slots")

    def get_master_volume(self) -> Any:
        """Read the authoritative master-volume state from the device."""
        return self._request("get_master_volume")

    def get_block_details(self, row: int, column: int, expected_preset_name: str) -> Any:
        """Read the live metadata and parameters for one occupied Grid cell."""
        _parameter_cell(row, column)
        return self._request("get_block_details", {
            "row": row,
            "column": column,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def get_lane_control_details(self, row: int, control: str, expected_preset_name: str) -> Any:
        """Read parameters attached to a row's Input Gate or Lane Output."""
        if isinstance(row, bool) or not isinstance(row, int) or not 0 <= row < 4:
            raise ValueError("row must be an integer from 0 through 3")
        if control not in ("inputGate", "laneOutput"):
            raise ValueError("control must be inputGate or laneOutput")
        return self._request("get_lane_control_details", {
            "row": row, "control": control,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def select_scene(self, scene: int, expected_preset_name: str) -> Any:
        """Temporarily select a bounded scene, guarded by the current preset name."""
        if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
            raise ValueError(f"scene must be an integer from 0 through {SCENE_COUNT - 1} (A through H)")
        return self._request("select_scene", {
            "scene": scene,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def copy_scene(
        self, from_scene: int, to_scene: int, swap: bool, expected_preset_name: str
    ) -> Any:
        """Copy or swap two scenes, guarded by the current preset name."""
        for name, scene in (("from_scene", from_scene), ("to_scene", to_scene)):
            if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
                raise ValueError(f"{name} must be an integer from 0 through {SCENE_COUNT - 1} (A through H)")
        if from_scene == to_scene:
            raise ValueError("from_scene and to_scene must be different")
        if not isinstance(swap, bool):
            raise ValueError("swap must be true or false")
        return self._request("copy_scene", {
            "fromScene": from_scene,
            "toScene": to_scene,
            "swap": swap,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_scene_label(self, scene: int, label: str | None, expected_preset_name: str) -> Any:
        """Set or clear a scene label, guarded by the current preset name."""
        if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
            raise ValueError(f"scene must be an integer from 0 through {SCENE_COUNT - 1} (A through H)")
        if label is not None:
            if not isinstance(label, str):
                raise ValueError("label must be a string or null")
            if len(label) > 32:
                raise ValueError("label must contain at most 32 characters")
            if any(ord(character) < 32 or ord(character) == 127 for character in label):
                raise ValueError("label must not contain control characters")
        return self._request("set_scene_label", {
            "scene": scene,
            "label": label,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_scene_color(self, scene: int, color: int, expected_preset_name: str) -> Any:
        """Set a scene ARGB color, guarded by the current preset name."""
        if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
            raise ValueError(f"scene must be an integer from 0 through {SCENE_COUNT - 1} (A through H)")
        if isinstance(color, bool) or not isinstance(color, int) or not 0 <= color <= 0xFFFFFFFF:
            raise ValueError("color must be an ARGB integer from 0 through 4294967295")
        return self._request("set_scene_color", {
            "scene": scene,
            "color": color,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def press_footswitch(self, index: int, expected_mode: str, expected_preset_name: str) -> Any:
        """Press one physical footswitch with current mode and preset guards."""
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= 10:
            raise ValueError("index must be an integer from 0 through 10")
        return self._request("press_footswitch", {
            "index": index,
            "expectedMode": _required_text(expected_mode, "expected_mode"),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def tap_tempo(self, expected_mode: str, expected_preset_name: str) -> Any:
        """Tap the dedicated physical tempo control with current-state guards."""
        return self._request("tap_tempo", {
            "expectedMode": _required_text(expected_mode, "expected_mode"),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def navigate_bank(
        self, direction: Literal[-1, 1], expected_preset_name: str, expected_position: int
    ) -> Any:
        """Navigate one bank down (-1) or up (1) after confirming the current position."""
        if isinstance(direction, bool) or direction not in (-1, 1):
            raise ValueError("direction must be -1 (down) or 1 (up)")
        if isinstance(expected_position, bool) or not isinstance(expected_position, int) or expected_position < 0:
            raise ValueError("expected_position must be a non-negative integer")
        return self._request("navigate_bank", {
            "direction": direction,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position,
        })

    def show_tuner(self, shown: bool) -> Any:
        """Show or hide the Quad Cortex tuner overlay."""
        return self._request("show_tuner", {"shown": shown})

    def show_gig_view(self, shown: bool) -> Any:
        """Show or hide Gig View on the Quad Cortex."""
        return self._request("show_gig_view", {"shown": shown})

    def select_mode_slot(self, slot: int, expected_preset_name: str) -> Any:
        """Select one of the three device-configured performance mode slots."""
        if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot <= 2:
            raise ValueError("slot must be 0, 1, or 2 (Mode Slot A, B, or C)")
        return self._request("select_mode_slot", {
            "slot": slot,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_master_volume(
        self,
        value: int,
        expected_value: int,
        confirm_risky_operation: bool,
    ) -> Any:
        """Set master output volume only after explicit user confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Master-volume changes require confirm_risky_operation=true.")
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            raise ValueError("value must be an integer from 0 through 100")
        if isinstance(expected_value, bool) or not isinstance(expected_value, int) or not 0 <= expected_value <= 100:
            raise ValueError("expected_value must be an integer from 0 through 100")
        return self._request("set_master_volume", {
            "value": value,
            "expectedValue": expected_value,
        })

    def recall_preset(
        self,
        setlist_key: str,
        position: int,
        expected_preset_name: str,
        expected_position: int,
    ) -> Any:
        """Recall a preset after guarding both the current name and position."""
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in (position, expected_position)):
            raise ValueError("position and expected_position must be non-negative integers")
        return self._request("recall_preset", {
            "setlistKey": _required_text(setlist_key, "setlist_key"),
            "position": position,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position,
        })

    def reload_preset(
        self,
        expected_preset_name: str,
        expected_position: int,
        confirm_risky_operation: bool,
    ) -> Any:
        """Discard unsaved edits and reload the active preset after confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Reloading a preset requires confirm_risky_operation=true.")
        if isinstance(expected_position, bool) or not isinstance(expected_position, int) or expected_position < 0:
            raise ValueError("expected_position must be a non-negative integer")
        return self._request("reload_preset", {
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position,
        })

    def set_tempo(self, bpm: int, expected_tempo: int, expected_preset_name: str) -> Any:
        """Temporarily set a bounded tempo after checking current tempo and preset."""
        if isinstance(bpm, bool) or not MINIMUM_TEMPO_BPM <= bpm <= MAXIMUM_TEMPO_BPM:
            raise ValueError(f"bpm must be an integer from {MINIMUM_TEMPO_BPM} through {MAXIMUM_TEMPO_BPM}")
        if isinstance(expected_tempo, bool) or not MINIMUM_TEMPO_BPM <= expected_tempo <= MAXIMUM_TEMPO_BPM:
            raise ValueError(f"expected_tempo must be an integer from {MINIMUM_TEMPO_BPM} through {MAXIMUM_TEMPO_BPM}")
        return self._request("set_tempo", {
            "bpm": bpm,
            "expectedTempo": expected_tempo,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_bypass(
        self,
        row: int,
        column: int,
        desired_bypassed: bool,
        expected_bypassed: bool,
        expected_scene: int,
        expected_preset_name: str,
    ) -> Any:
        """Temporarily bypass or enable a block with preset, scene and bypass guards."""
        _grid_cell(row, column)
        if isinstance(expected_scene, bool) or not isinstance(expected_scene, int) or not 0 <= expected_scene < SCENE_COUNT:
            raise ValueError(f"expected_scene must be an integer from 0 through {SCENE_COUNT - 1}")
        return self._request("set_bypass", {
            "row": row,
            "column": column,
            "desiredBypassed": desired_bypassed,
            "expectedBypassed": expected_bypassed,
            "expectedScene": expected_scene,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_parameter(
        self,
        row: int,
        column: int,
        parameter_index: int,
        value: float,
        expected_value: float,
        expected_scene: int,
        expected_preset_name: str,
    ) -> Any:
        """Temporarily set a normalized block parameter with full stale-state guards."""
        return self._request("set_parameter", _parameter_args(
            row, column, parameter_index, value, expected_value,
            expected_scene, expected_preset_name,
        ))

    def set_parameter_scene_mode(
        self, row: int, column: int, parameter_index: int, enabled: bool,
        expected_preset_name: str,
    ) -> Any:
        """Enable or disable per-scene storage for a block parameter."""
        _parameter_cell(row, column)
        if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
            raise ValueError("parameter_index must be a non-negative integer")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        return self._request("set_parameter_scene_mode", {
            "row": row, "column": column, "parameterIndex": parameter_index,
            "enabled": enabled,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_parameter_expression(
        self, row: int, column: int, parameter_index: int, pedal: Literal[0, 1, 2],
        minimum: float, maximum: float, expected_preset_name: str,
    ) -> Any:
        """Assign or clear an expression pedal using a normalized sweep range."""
        _parameter_cell(row, column)
        if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
            raise ValueError("parameter_index must be a non-negative integer")
        if isinstance(pedal, bool) or pedal not in (0, 1, 2):
            raise ValueError("pedal must be 0, 1, or 2")
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1 for value in (minimum, maximum)):
            raise ValueError("minimum and maximum must be normalized numbers from 0 through 1")
        return self._request("set_parameter_expression", {
            "row": row, "column": column, "parameterIndex": parameter_index,
            "pedal": pedal, "minimum": float(minimum), "maximum": float(maximum),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_lane_control_parameter(
        self, row: int, control: str, parameter_index: int, value: float,
        expected_value: float, expected_preset_name: str,
    ) -> Any:
        """Set an Input Gate or Lane Output parameter with stale-value guards."""
        self.get_lane_control_details(row, control, expected_preset_name)
        for name, candidate in (("value", value), ("expected_value", expected_value)):
            if isinstance(candidate, bool) or not isinstance(candidate, (int, float)) or not math.isfinite(candidate) or not 0 <= candidate <= 1:
                raise ValueError(f"{name} must be a normalized number from 0 through 1")
        if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
            raise ValueError("parameter_index must be a non-negative integer")
        return self._request("set_lane_control_parameter", {
            "row": row, "control": control, "parameterIndex": parameter_index,
            "value": float(value), "expectedValue": float(expected_value),
            "expectedPresetName": expected_preset_name,
        })

    def set_lane_control_scene_mode(
        self, row: int, control: str, parameter_index: int, enabled: bool,
        expected_preset_name: str,
    ) -> Any:
        """Enable or disable per-scene storage for a row control parameter."""
        self.get_lane_control_details(row, control, expected_preset_name)
        if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
            raise ValueError("parameter_index must be a non-negative integer")
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        return self._request("set_lane_control_scene_mode", {
            "row": row, "control": control, "parameterIndex": parameter_index,
            "enabled": enabled, "expectedPresetName": expected_preset_name,
        })

    def set_expression_bypass(
        self, row: int, column: int, pedal: Literal[1, 2], mode: Literal[0, 1, 2],
        invert: bool, delay_ms: int, latch_emulation: bool, expected_preset_name: str,
    ) -> Any:
        """Assign EXP 1/2 to block bypass with verified switch behavior."""
        _grid_cell(row, column)
        if isinstance(pedal, bool) or pedal not in (1, 2):
            raise ValueError("pedal must be 1 or 2")
        if isinstance(mode, bool) or mode not in (0, 1, 2):
            raise ValueError("mode must be 0, 1, or 2")
        if not isinstance(invert, bool) or not isinstance(latch_emulation, bool):
            raise ValueError("invert and latch_emulation must be booleans")
        if isinstance(delay_ms, bool) or not isinstance(delay_ms, int) or not 0 <= delay_ms <= 5000:
            raise ValueError("delay_ms must be an integer from 0 through 5000")
        return self._request("set_expression_bypass", {
            "row": row, "column": column, "pedal": pedal, "mode": mode,
            "invert": invert, "delayMs": delay_ms, "latchEmulation": latch_emulation,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def preview_parameter(
        self, row: int, column: int, parameter_index: int, value: float,
        expected_value: float, expected_scene: int, expected_preset_name: str,
    ) -> Any:
        """Preview a normalized parameter value with the same stale-state guards."""
        return self._request("preview_parameter", _parameter_args(
            row, column, parameter_index, value, expected_value,
            expected_scene, expected_preset_name,
        ))

    def preview_lane_control_parameter(
        self, row: int, control: str, parameter_index: int, value: float,
        expected_value: float, expected_preset_name: str,
    ) -> Any:
        """Preview a row control parameter without waiting for final readback."""
        if control not in ("inputGate", "laneOutput"):
            raise ValueError("control must be inputGate or laneOutput")
        if isinstance(row, bool) or not isinstance(row, int) or not 0 <= row < 4:
            raise ValueError("row must be an integer from 0 through 3")
        return self._request("preview_lane_control_parameter", {
            "row": row, "control": control, "parameterIndex": parameter_index,
            "value": float(value), "expectedValue": float(expected_value),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def move_block(self, row: int, from_column: int, to_column: int, expected_model_id: int, expected_preset_name: str) -> Any:
        """Move a block within its row after validating its identity."""
        _grid_cell(row, from_column)
        _grid_cell(row, to_column)
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id < 0:
            raise ValueError("expected_model_id must be a non-negative integer")
        return self._request("move_block", {"row": row, "fromColumn": from_column, "toColumn": to_column,
            "expectedModelId": expected_model_id, "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def add_block(self, row: int, column: int, model_id: int, expected_preset_name: str) -> Any:
        """Add an installed model to an empty Grid cell."""
        _grid_cell(row, column)
        if isinstance(model_id, bool) or not isinstance(model_id, int) or model_id < 0:
            raise ValueError("model_id must be a non-negative integer")
        return self._request("add_block", {"row": row, "column": column, "modelId": model_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def remove_block(self, row: int, column: int, expected_model_id: int, expected_preset_name: str) -> Any:
        """Remove a Grid block after validating its identity."""
        _grid_cell(row, column)
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id < 0:
            raise ValueError("expected_model_id must be a non-negative integer")
        return self._request("remove_block", {"row": row, "column": column, "expectedModelId": expected_model_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def set_block_footswitch(self, row: int, column: int, footswitch: int | None,
                             expected_footswitch: int | None, expected_model_id: int,
                             expected_preset_name: str) -> Any:
        """Assign or clear a block footswitch with complete stale-state guards."""
        _grid_cell(row, column)
        if any(value is not None and (isinstance(value, bool) or not 0 <= value <= 7)
               for value in (footswitch, expected_footswitch)):
            raise ValueError("footswitch values must be 0 through 7 or null")
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id < 0:
            raise ValueError("expected_model_id must be a non-negative integer")
        return self._request("set_block_footswitch", {"row": row, "column": column, "footswitch": footswitch,
            "expectedFootswitch": expected_footswitch, "expectedModelId": expected_model_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def set_stomp_momentary(self, footswitch: int, momentary: bool, expected_preset_name: str) -> Any:
        """Set a single-block STOMP footswitch to momentary or latching behavior."""
        if isinstance(footswitch, bool) or not isinstance(footswitch, int) or not 0 <= footswitch < SCENE_COUNT:
            raise ValueError(f"footswitch must be an integer from 0 through {SCENE_COUNT - 1}")
        if not isinstance(momentary, bool):
            raise ValueError("momentary must be a boolean")
        return self._request("set_stomp_momentary", {
            "footswitch": footswitch, "momentary": momentary,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_stomp_label(self, footswitch: int, label: str, expected_preset_name: str) -> Any:
        """Set the visible label for an assigned STOMP footswitch."""
        if isinstance(footswitch, bool) or not isinstance(footswitch, int) or not 0 <= footswitch < SCENE_COUNT:
            raise ValueError(f"footswitch must be an integer from 0 through {SCENE_COUNT - 1}")
        if not isinstance(label, str) or len(label) > 32 or any(ord(character) < 32 or ord(character) == 127 for character in label):
            raise ValueError("label must contain at most 32 non-control characters")
        return self._request("set_stomp_label", {
            "footswitch": footswitch, "label": label,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_midi_out(
        self, source: int, messages: list[dict[str, int]], expected_preset_name: str,
    ) -> Any:
        """Replace the MIDI Out messages for footswitch A-H or EXP 1/2."""
        if isinstance(source, bool) or not isinstance(source, int) or not 0 <= source <= 9:
            raise ValueError("source must be an integer from 0 through 9")
        return self._request("set_midi_out", {
            "source": source, "messages": _midi_messages(messages),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_preset_load_midi_out(
        self, messages: list[dict[str, int]], expected_preset_name: str,
    ) -> Any:
        """Replace the MIDI Out messages sent when the current preset loads."""
        return self._request("set_preset_load_midi_out", {
            "messages": _midi_messages(messages),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def set_chain_input(self, row: int, input_id: int, expected_input_id: int, expected_preset_name: str) -> Any:
        """Change a signal-row input with route and preset guards."""
        _grid_cell(row, 0)
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in (input_id, expected_input_id)):
            raise ValueError("input route IDs must be non-negative integers")
        return self._request("set_chain_input", {"row": row, "inputId": input_id, "expectedInputId": expected_input_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def set_chain_output(self, row: int, output_id: int, expected_output_id: int, expected_preset_name: str) -> Any:
        """Change a signal-row output with route and preset guards."""
        _grid_cell(row, 0)
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in (output_id, expected_output_id)):
            raise ValueError("output route IDs must be non-negative integers")
        return self._request("set_chain_output", {"row": row, "outputId": output_id, "expectedOutputId": expected_output_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def set_chain_split(self, row: int, split_column: int | None, mix_column: int | None,
                        expected_split_column: int | None, expected_mix_column: int | None,
                        expected_preset_name: str) -> Any:
        """Set or clear a signal-row split with complete route guards."""
        _grid_cell(row, 0)
        values = (split_column, mix_column, expected_split_column, expected_mix_column)
        if any(value is not None and (isinstance(value, bool) or not -1 <= value <= 7) for value in values):
            raise ValueError("split and mix columns must be -1 through 7 or null")
        return self._request("set_chain_split", {"row": row, "splitColumn": split_column, "mixColumn": mix_column,
            "expectedSplitColumn": expected_split_column, "expectedMixColumn": expected_mix_column,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def set_split_mute(self, row: int, muted: bool, expected_muted: bool,
                       expected_preset_name: str) -> Any:
        """Mute or unmute the shared splitter/mixer path with stale-state protection."""
        if isinstance(row, bool) or row not in (0, 2):
            raise ValueError("splitter/mixer controls are available only on rows 0 and 2")
        if not isinstance(muted, bool) or not isinstance(expected_muted, bool):
            raise ValueError("muted and expected_muted must be booleans")
        return self._request("set_split_mute", {
            "row": row,
            "muted": muted,
            "expectedMuted": expected_muted,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def save_preset_as(
        self,
        setlist_key: str,
        position: int,
        name: str,
        expected_preset_name: str,
        expected_position: int,
        confirm_overwrite: bool,
        confirm_persistent_write: bool,
    ) -> Any:
        """Persist a copy only after the host/user supplies an explicit final confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Persistent Save As requires confirm_persistent_write=true after destination review.")
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in (position, expected_position)):
            raise ValueError("position and expected_position must be non-negative integers")
        return self._request("save_preset_as", {
            "setlistKey": _required_text(setlist_key, "setlist_key"),
            "position": position,
            "name": _required_text(name, "name"),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position,
            "confirmOverwrite": confirm_overwrite,
        })

    def create_device_backup(self, name: str, confirm_persistent_write: bool) -> Any:
        """Create a complete local device backup after explicit confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Device backup requires confirm_persistent_write=true.")
        return self._request("create_device_backup", {"name": _required_text(name, "name")})

    def rename_current_preset(
        self,
        new_name: str,
        expected_preset_name: str,
        expected_position: int,
        confirm_persistent_write: bool,
    ) -> Any:
        """Rename the active stored user preset after an explicit persistent-write confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Preset rename requires confirm_persistent_write=true.")
        if isinstance(expected_position, bool) or not isinstance(expected_position, int) or expected_position < 0:
            raise ValueError("expected_position must be a non-negative integer")
        return self._request("rename_current_preset", {
            "name": _required_text(new_name, "new_name"),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position,
            "confirmRename": True,
        })

    def copy_preset(
        self,
        source_setlist_key: str,
        source_position: int,
        source_name: str,
        destination_setlist_key: str,
        destination_position: int,
        expected_preset_name: str,
        expected_position: int,
        confirm_overwrite: bool,
        confirm_persistent_write: bool,
    ) -> Any:
        """Copy a device preset only after destination review and confirmation."""
        if confirm_persistent_write is not True:
            raise ValueError("Preset copy requires confirm_persistent_write=true after destination review.")
        positions = (source_position, destination_position, expected_position)
        if any(isinstance(position, bool) or not isinstance(position, int) or position < 0 for position in positions):
            raise ValueError("source, destination, and expected positions must be non-negative integers")
        return self._request("copy_preset", {
            "sourceSetlistKey": _required_text(source_setlist_key, "source_setlist_key"),
            "sourcePosition": source_position,
            "sourceName": _required_text(source_name, "source_name"),
            "destinationSetlistKey": _required_text(destination_setlist_key, "destination_setlist_key"),
            "destinationPosition": destination_position,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position,
            "confirmOverwrite": confirm_overwrite,
        })

    def get_global_eq(self) -> Any:
        return self._request("get_global_eq")

    def set_global_eq_bypassed(self, bypassed: bool, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Global EQ changes require confirm_persistent_write=true.")
        return self._request("set_global_eq_bypassed", {"bypassed": bypassed})

    def set_global_eq_band(self, band: int, gain: float | None, frequency: float | None,
                           q: float | None, filter_type: int | None, enabled: bool | None,
                           confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Global EQ changes require confirm_persistent_write=true.")
        if isinstance(band, bool) or not 1 <= band <= 5:
            raise ValueError("band must be an integer from 1 through 5")
        if filter_type is not None and (isinstance(filter_type, bool) or not isinstance(filter_type, int) or not 0 <= filter_type <= 4):
            raise ValueError("filter_type must be an integer from 0 through 4 or null")
        return self._request("set_global_eq_band", {"band": band, "gain": gain,
            "frequency": frequency, "q": q, "filterType": filter_type, "enabled": enabled})

    def set_global_eq_output(self, level: float | None, out12: bool | None, out34: bool | None,
                             confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Global EQ changes require confirm_persistent_write=true.")
        return self._request("set_global_eq_output", {"level": level, "out12": out12, "out34": out34})

    def get_mode_cycle(self) -> Any:
        return self._request("get_mode_cycle")

    def set_mode_cycle(self, slots: list[int], confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Mode-cycle changes require confirm_persistent_write=true.")
        if not isinstance(slots, list) or not 1 <= len(slots) <= 3 or len(slots) != len(set(slots)) or any(isinstance(v, bool) or not isinstance(v, int) or not 0 <= v <= 8 for v in slots):
            raise ValueError("slots must contain one through three mode integers from 0 through 8")
        return self._request("set_mode_cycle", {"slots": slots})

    def get_global_tempo_settings(self) -> Any:
        return self._request("get_global_tempo_settings")

    def set_tempo_metronome(self, led_enabled: bool | None, volume_db: float | None,
                            running: bool | None, pan: float | None, time_signature: str | None,
                            subdivision: str | None, sound: str | None, routing: str | None,
                            beats: list[str] | None, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Tempo settings require confirm_persistent_write=true.")
        return self._request("set_tempo_metronome", {"ledEnabled": led_enabled,
            "volumeDb": volume_db, "running": running, "pan": pan,
            "timeSignature": time_signature, "subdivision": subdivision, "sound": sound,
            "routing": routing, "beats": beats})

    def set_tempo_mode(self, mode: str, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Tempo mode changes require confirm_persistent_write=true.")
        if mode not in ("PRESET", "GLOBAL"):
            raise ValueError("mode must be PRESET or GLOBAL")
        return self._request("set_tempo_mode", {"mode": mode})

    def get_looper_status(self) -> Any:
        return self._request("get_looper_status")

    def control_looper(self, command: str, value: int | None) -> Any:
        allowed = {"open", "close", "duplicate", "oneShot", "halfSpeed", "punch", "record", "play", "reverse", "undoRedo", "duplicateMode", "quantize", "midiClockStart", "performMode", "routingMode"}
        if command not in allowed:
            raise ValueError("command is not a supported Looper X command")
        if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 13):
            raise ValueError("value must be an integer from 0 through 13 or null")
        return self._request("control_looper", {"command": command, "value": value})

    def list_recents(self) -> Any:
        return self._request("list_recents")

    def list_favorites(self) -> Any:
        return self._request("list_favorites")

    def set_favorite(self, name: str, folder_key: str, folder_name: str, is_factory: bool,
                     favorite: bool, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Favorite changes require confirm_persistent_write=true.")
        return self._request("set_favorite", {"name": _required_text(name, "name"),
            "folderKey": _required_text(folder_key, "folder_key"),
            "folderName": _required_text(folder_name, "folder_name"),
            "isFactory": is_factory, "favorite": favorite})

    def list_pinned_models(self) -> Any:
        return self._request("list_pinned_models")

    def set_model_pinned(self, model_id: int, pinned: bool, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Pin changes require confirm_persistent_write=true.")
        if isinstance(model_id, bool) or not isinstance(model_id, int) or model_id < 0:
            raise ValueError("model_id must be a non-negative integer")
        return self._request("set_model_pinned", {"modelId": model_id, "pinned": pinned})

    def list_captures(self) -> Any:
        return self._request("list_captures")

    def load_capture(self, row: int, column: int, key: str, name: str, model_id: int | None,
                     expected_model_id: int | None, expected_preset_name: str) -> Any:
        _grid_cell(row, column)
        return self._request("load_capture", {"row": row, "column": column,
            "key": _required_text(key, "key"), "name": _required_text(name, "name"),
            "modelId": model_id, "expectedModelId": expected_model_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def list_irs(self, folder: str | None) -> Any:
        return self._request("list_irs", {"folder": folder})

    def load_ir(self, row: int, column: int, key: str, name: str, slot: int,
                model_id: int | None, expected_model_id: int | None,
                expected_preset_name: str) -> Any:
        _grid_cell(row, column)
        if isinstance(slot, bool) or slot not in (0, 1):
            raise ValueError("slot must be 0 or 1")
        return self._request("load_ir", {"row": row, "column": column,
            "key": _required_text(key, "key"), "name": _required_text(name, "name"),
            "slot": slot, "modelId": model_id, "expectedModelId": expected_model_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def create_setlist(self, name: str, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Setlist creation requires confirm_persistent_write=true.")
        return self._request("create_setlist", {"name": _required_text(name, "name")})

    def delete_setlist(self, name: str, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Setlist deletion requires confirm_persistent_write=true.")
        return self._request("delete_setlist", {"name": _required_text(name, "name")})

    def duplicate_setlist(self, source_setlist_key: str, destination_name: str, limit: int | None,
                          expected_preset_name: str, expected_position: int,
                          confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Setlist duplication requires confirm_persistent_write=true.")
        return self._request("duplicate_setlist", {"sourceSetlistKey": _required_text(source_setlist_key, "source_setlist_key"),
            "destinationName": _required_text(destination_name, "destination_name"), "limit": limit,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position})

    def delete_preset(self, setlist_key: str, name: str, confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Preset deletion requires confirm_persistent_write=true.")
        return self._request("delete_preset", {"setlistKey": _required_text(setlist_key, "setlist_key"),
            "name": _required_text(name, "name")})

    def move_preset(self, setlist_key: str, name: str, position: int,
                    confirm_persistent_write: bool) -> Any:
        if confirm_persistent_write is not True:
            raise ValueError("Preset move requires confirm_persistent_write=true.")
        if isinstance(position, bool) or not isinstance(position, int) or position < 0:
            raise ValueError("position must be a non-negative integer")
        return self._request("move_preset", {"setlistKey": _required_text(setlist_key, "setlist_key"),
            "name": _required_text(name, "name"), "position": position})


def create_mcp(backend: QcBackend, **server_options: Any) -> MCPServer:
    tools = QcTools(backend)
    server = MCPServer(
        "NDSP Quad Cortex",
        instructions=MCP_INSTRUCTIONS,
        **server_options,
    )

    @server.resource("qc://status")
    def status_resource() -> str:
        """Connection and gateway capability status."""
        return json.dumps(tools.get_status(), ensure_ascii=False)

    @server.resource("qc://current-preset")
    def preset_resource() -> str:
        """Authoritative current preset, scene, blocks, tempo, mode and dirty state."""
        return json.dumps(tools.get_current_preset(), ensure_ascii=False)

    @server.resource("qc://models")
    def models_resource() -> str:
        """Models currently installed and available on this Quad Cortex."""
        return json.dumps(tools.list_models(None), ensure_ascii=False)

    read_only = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)
    live_write = ToolAnnotations(
        read_only_hint=False,
        destructive_hint=False,
        idempotent_hint=False,
        open_world_hint=False,
    )
    persistent_write = ToolAnnotations(
        read_only_hint=False,
        destructive_hint=True,
        idempotent_hint=False,
        open_world_hint=False,
    )
    risky_write = ToolAnnotations(
        read_only_hint=False,
        destructive_hint=True,
        idempotent_hint=False,
        open_world_hint=False,
    )
    annotations = {
        "read": read_only,
        "live-write": live_write,
        "persistent-write": persistent_write,
        "risky-write": risky_write,
    }
    for name, action in SHARED_QC_ACTIONS.items():
        server.tool(
            description=action["description"],
            annotations=annotations[action["classification"]],
        )(getattr(tools, name))
    return server
