"""MCP resources and typed tools for safe Quad Cortex control."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Literal

from mcp.server import MCPServer
from mcp.types import ToolAnnotations

from .backend import QcBackend
from .generated_actions import SHARED_QC_ACTIONS
from .generated_domain import (
    GRID_COLUMNS,
    GRID_ROWS,
    MAXIMUM_TEMPO_BPM,
    MINIMUM_TEMPO_BPM,
    SCENE_COUNT,
)


def _required_text(value: str, label: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{label} is required and must come from a fresh device snapshot.")
    return cleaned


def _grid_cell(row: int, column: int) -> None:
    if isinstance(row, bool) or not 0 <= row < GRID_ROWS:
        raise ValueError(f"row must be an integer from 0 through {GRID_ROWS - 1}")
    if isinstance(column, bool) or not 0 <= column < GRID_COLUMNS:
        raise ValueError(f"column must be an integer from 0 through {GRID_COLUMNS - 1}")


def _parameter_args(
    row: int, column: int, parameter_index: int, value: float,
    expected_value: float, expected_scene: int, expected_preset_name: str,
) -> dict[str, Any]:
    _grid_cell(row, column)
    if isinstance(parameter_index, bool) or parameter_index < 0:
        raise ValueError("parameter_index must be a non-negative integer")
    if isinstance(value, bool) or not 0.0 <= value <= 1.0:
        raise ValueError("value must be normalized from 0.0 through 1.0")
    if isinstance(expected_value, bool) or not 0.0 <= expected_value <= 1.0:
        raise ValueError("expected_value must be normalized from 0.0 through 1.0")
    if isinstance(expected_scene, bool) or not 0 <= expected_scene < SCENE_COUNT:
        raise ValueError(f"expected_scene must be an integer from 0 through {SCENE_COUNT - 1}")
    return {
        "row": row, "column": column, "parameterIndex": parameter_index,
        "value": float(value), "expectedValue": float(expected_value),
        "expectedScene": expected_scene,
        "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
    }


class QcTools:
    """Testable application adapter; every mutation maps to one allowlisted method."""

    def __init__(self, backend: QcBackend) -> None:
        self.backend = backend

    def _request(self, action: str, params: dict[str, Any] | None = None) -> Any:
        return self.backend.request(SHARED_QC_ACTIONS[action]["rpc"], params)

    def get_current_preset(self) -> Any:
        """Read the authoritative current preset, scene, blocks, tempo and dirty state."""
        return self._request("get_current_preset")

    def get_status(self) -> Any:
        """Read gateway availability and connection capabilities."""
        return self.backend.request("system.status")

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
        if isinstance(after_sequence, bool) or after_sequence < 0:
            raise ValueError("after_sequence must be a non-negative integer")
        if isinstance(limit, bool) or not 1 <= limit <= 4096:
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

    def get_preset_screenshot(
        self, folder_name: str, position: int, is_factory: bool
    ) -> Any:
        """Read a device-rendered preset screenshot without recalling it."""
        if isinstance(position, bool) or position < 0:
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

    def tap_screen(self, x: float, y: float, confirm_risky_operation: bool) -> Any:
        """Tap one reviewed physical-screen coordinate after explicit confirmation."""
        if confirm_risky_operation is not True:
            raise ValueError("Screen taps require confirm_risky_operation=true.")
        if isinstance(x, bool) or not isinstance(x, (int, float)) or not 0 <= x < 800:
            raise ValueError("x must be a real coordinate from 0 up to (but not including) 800")
        if isinstance(y, bool) or not isinstance(y, (int, float)) or not 0 <= y < 480:
            raise ValueError("y must be a real coordinate from 0 up to (but not including) 480")
        return self._request("tap_screen", {"x": float(x), "y": float(y)})

    def list_models(self) -> Any:
        """List device models installed and available on the connected Quad Cortex."""
        return self._request("list_models")

    def list_presets(self, refresh: bool = False, setlist_key: str | None = None) -> Any:
        """List presets, optionally refreshing the device index or restricting a setlist."""
        params: dict[str, Any] = {"refresh": refresh}
        if setlist_key is not None:
            params["setlistKey"] = setlist_key
        return self._request("list_presets", params)

    def list_preset_folders(self, refresh: bool = False) -> Any:
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
        _grid_cell(row, column)
        return self._request("get_block_details", {
            "row": row,
            "column": column,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def select_scene(self, scene: int, expected_preset_name: str) -> Any:
        """Temporarily select a bounded scene, guarded by the current preset name."""
        if isinstance(scene, bool) or not 0 <= scene < SCENE_COUNT:
            raise ValueError(f"scene must be an integer from 0 through {SCENE_COUNT - 1} (A through H)")
        return self._request("select_scene", {
            "scene": scene,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def press_footswitch(self, index: int, expected_mode: str, expected_preset_name: str) -> Any:
        """Press one physical footswitch with current mode and preset guards."""
        if isinstance(index, bool) or not 0 <= index <= 10:
            raise ValueError("index must be an integer from 0 through 10")
        return self._request("press_footswitch", {
            "index": index,
            "expectedMode": _required_text(expected_mode, "expected_mode"),
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
        })

    def navigate_bank(
        self, direction: Literal[-1, 1], expected_preset_name: str, expected_position: int
    ) -> Any:
        """Navigate one bank down (-1) or up (1) after confirming the current position."""
        if isinstance(direction, bool) or direction not in (-1, 1):
            raise ValueError("direction must be -1 (down) or 1 (up)")
        if isinstance(expected_position, bool) or expected_position < 0:
            raise ValueError("expected_position must be a non-negative integer")
        return self._request("navigate_bank", {
            "direction": direction,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name"),
            "expectedPosition": expected_position,
        })

    def show_tuner(self, shown: bool = True) -> Any:
        """Show or hide the Quad Cortex tuner overlay."""
        return self._request("show_tuner", {"shown": shown})

    def show_gig_view(self, shown: bool = True) -> Any:
        """Show or hide Gig View on the Quad Cortex."""
        return self._request("show_gig_view", {"shown": shown})

    def select_mode_slot(self, slot: int, expected_preset_name: str) -> Any:
        """Select one of the three device-configured performance mode slots."""
        if isinstance(slot, bool) or not 0 <= slot <= 2:
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
        if isinstance(value, bool) or not 0 <= value <= 100:
            raise ValueError("value must be an integer from 0 through 100")
        if isinstance(expected_value, bool) or not 0 <= expected_value <= 100:
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
        if isinstance(position, bool) or position < 0 or isinstance(expected_position, bool) or expected_position < 0:
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
        if isinstance(expected_position, bool) or expected_position < 0:
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
        if isinstance(expected_scene, bool) or not 0 <= expected_scene < SCENE_COUNT:
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

    def preview_parameter(
        self, row: int, column: int, parameter_index: int, value: float,
        expected_value: float, expected_scene: int, expected_preset_name: str,
    ) -> Any:
        """Preview a normalized parameter value with the same stale-state guards."""
        return self._request("preview_parameter", _parameter_args(
            row, column, parameter_index, value, expected_value,
            expected_scene, expected_preset_name,
        ))

    def move_block(self, row: int, from_column: int, to_column: int, expected_model_id: int, expected_preset_name: str) -> Any:
        """Move a block within its row after validating its identity."""
        _grid_cell(row, from_column)
        _grid_cell(row, to_column)
        if isinstance(expected_model_id, bool) or expected_model_id < 0:
            raise ValueError("expected_model_id must be a non-negative integer")
        return self._request("move_block", {"row": row, "fromColumn": from_column, "toColumn": to_column,
            "expectedModelId": expected_model_id, "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def add_block(self, row: int, column: int, model_id: int, expected_preset_name: str) -> Any:
        """Add an installed model to an empty Grid cell."""
        _grid_cell(row, column)
        if isinstance(model_id, bool) or model_id < 0:
            raise ValueError("model_id must be a non-negative integer")
        return self._request("add_block", {"row": row, "column": column, "modelId": model_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def remove_block(self, row: int, column: int, expected_model_id: int, expected_preset_name: str) -> Any:
        """Remove a Grid block after validating its identity."""
        _grid_cell(row, column)
        if isinstance(expected_model_id, bool) or expected_model_id < 0:
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
        if isinstance(expected_model_id, bool) or expected_model_id < 0:
            raise ValueError("expected_model_id must be a non-negative integer")
        return self._request("set_block_footswitch", {"row": row, "column": column, "footswitch": footswitch,
            "expectedFootswitch": expected_footswitch, "expectedModelId": expected_model_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def set_chain_input(self, row: int, input_id: int, expected_input_id: int, expected_preset_name: str) -> Any:
        """Change a signal-row input with route and preset guards."""
        _grid_cell(row, 0)
        if any(isinstance(value, bool) or value < 0 for value in (input_id, expected_input_id)):
            raise ValueError("input route IDs must be non-negative integers")
        return self._request("set_chain_input", {"row": row, "inputId": input_id, "expectedInputId": expected_input_id,
            "expectedPresetName": _required_text(expected_preset_name, "expected_preset_name")})

    def set_chain_output(self, row: int, output_id: int, expected_output_id: int, expected_preset_name: str) -> Any:
        """Change a signal-row output with route and preset guards."""
        _grid_cell(row, 0)
        if any(isinstance(value, bool) or value < 0 for value in (output_id, expected_output_id)):
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
        if isinstance(position, bool) or position < 0 or isinstance(expected_position, bool) or expected_position < 0:
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
        if isinstance(expected_position, bool) or expected_position < 0:
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
        if any(isinstance(position, bool) or position < 0 for position in positions):
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


def create_mcp(backend: QcBackend, **server_options: Any) -> MCPServer:
    tools = QcTools(backend)
    server = MCPServer(
        "NDSP Quad Cortex",
        instructions=(
            "Inspect qc://current-preset before changing the device. Every mutating tool uses "
            "expected-state values from a fresh snapshot. Changes are temporary unless the separately "
            "confirmed save_preset_as tool is called. Never invent expected values."
        ),
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
        return json.dumps(tools.list_models(), ensure_ascii=False)

    read_only = ToolAnnotations(read_only_hint=True, open_world_hint=False)
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
