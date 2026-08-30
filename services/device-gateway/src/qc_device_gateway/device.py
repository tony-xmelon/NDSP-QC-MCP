"""Read-only pyquadcortex adapter owned exclusively by the gateway process."""

from __future__ import annotations

from datetime import datetime, timezone
import time
from typing import Any


MIN_TEMPO_BPM = 40
MAX_TEMPO_BPM = 240

INPUT_ROUTE_LABELS = {
    0: "Internal", 1: "In 1", 2: "In 2", 3: "In 1/2", 4: "Return 1",
    5: "Return 2", 6: "Return 1/2", 7: "Prev. Row", 8: "USB 5",
    9: "USB 6", 10: "USB 7", 11: "USB 8", 12: "USB 5/6",
    13: "USB 7/8", 14: "Sidechain",
}

OUTPUT_ROUTE_LABELS = {
    0: "Internal", 1: "Out 1/2", 2: "Out 3/4", 3: "Send 1/2", 4: "Out 1",
    5: "Out 2", 6: "Out 3", 7: "Out 4", 8: "Send 1", 9: "Send 2",
    10: "USB 5", 11: "USB 6", 12: "USB 7", 13: "USB 8", 14: "USB 5/6",
    15: "USB 7/8", 16: "Row 3", 17: "Row 4", 18: "Rows 3/4",
    19: "Multi Out", 20: "USB 3", 21: "USB 4", 22: "USB 3/4",
}


def _send_qc_midi_cc(controller: int, value: int = 127) -> str:
    """Send one Windows MIDI CC to the connected Quad Cortex endpoint."""
    import ctypes
    from ctypes import wintypes
    import sys

    if sys.platform != "win32":
        raise RuntimeError("QC footswitch emulation currently requires Windows MIDI.")

    class MidiOutCaps(ctypes.Structure):
        _fields_ = [
            ("wMid", wintypes.WORD),
            ("wPid", wintypes.WORD),
            ("vDriverVersion", wintypes.DWORD),
            ("szPname", wintypes.WCHAR * 32),
            ("wTechnology", wintypes.WORD),
            ("wVoices", wintypes.WORD),
            ("wNotes", wintypes.WORD),
            ("wChannelMask", wintypes.WORD),
            ("dwSupport", wintypes.DWORD),
        ]

    winmm = ctypes.WinDLL("winmm")
    endpoint: tuple[int, str] | None = None
    for device_id in range(winmm.midiOutGetNumDevs()):
        caps = MidiOutCaps()
        result = winmm.midiOutGetDevCapsW(device_id, ctypes.byref(caps), ctypes.sizeof(caps))
        if result == 0 and "quad cortex" in caps.szPname.casefold():
            endpoint = (device_id, caps.szPname)
            break
    if endpoint is None:
        raise RuntimeError("Quad Cortex Windows MIDI output was not found. Enable MIDI over USB and reconnect.")

    handle = wintypes.HANDLE()
    result = winmm.midiOutOpen(ctypes.byref(handle), endpoint[0], 0, 0, 0)
    if result != 0:
        raise RuntimeError(f"Could not open the Quad Cortex MIDI output (Windows MIDI error {result}).")
    try:
        message = 0xB0 | (controller << 8) | (value << 16)
        result = winmm.midiOutShortMsg(handle, message)
        if result != 0:
            raise RuntimeError(f"Could not send the Quad Cortex MIDI command (Windows MIDI error {result}).")
    finally:
        winmm.midiOutClose(handle)
    return endpoint[1]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _block_kind(category: str) -> str:
    value = category.casefold()
    if "amp" in value or "capture" in value:
        return "capture" if "capture" in value else "amp"
    if "cab" in value or "impulse" in value:
        return "cab"
    if "delay" in value:
        return "delay"
    if "reverb" in value:
        return "reverb"
    if any(word in value for word in ("chorus", "flanger", "modulation", "pitch")):
        return "mod"
    return "utility"


def _block_color(category: str, name: str) -> str:
    """Return the CorOS category color used by the Grid block artwork."""
    value = category.casefold()
    model = name.casefold()
    if "gate" in model or "wah" in value or "filter" in value:
        return "#ffd236"
    if "equalizer" in value:
        return "#0a74e0"
    if "pitch" in value:
        return "#e44a5d"
    if "modulation" in value:
        return "#3500f1"
    if "compressor" in value:
        return "#45f862"
    if "overdrive" in value or "capture" in value:
        return "#ff7000"
    if "amplifier" in value:
        return "#ff2727"
    if "cab" in value or "impulse" in value:
        return "#6954ff"
    if "fx loop" in value:
        return "#00ffdd"
    if "delay" in value or "reverb" in value:
        return "#00ffdd"
    return "#959595"


def _stomp_color(targets: list[dict[str, Any]]) -> str:
    """Return the physical STOMP lamp color (not the Grid block color)."""
    if len(targets) > 1:
        return "#f4f4f4"
    if not targets:
        return "#626367"
    target = targets[0]
    category = str(target.get("category", target.get("kind", ""))).casefold()
    name = str(target.get("name", "")).casefold()
    if "utility" in category or "gate" in name:
        return "#f4f4f4"
    if "pitch" in category:
        return "#ffd236"
    if "equalizer" in category:
        return "#0a74e0"
    if "modulation" in category:
        return "#3500f1"
    if "overdrive" in category or "capture" in category:
        return "#ff7000"
    if "amplifier" in category:
        return "#ff2727"
    if "fx loop" in category:
        return "#00ffdd"
    if "delay" in category or "reverb" in category:
        return "#00ffdd"
    if "wah" in category or "filter" in category:
        return "#ffd236"
    return "#f4f4f4"


def _effective_parameter_value(state: Any, scene: int) -> Any:
    if not state.values:
        return None
    return state.values[scene] if state.scene_mode and scene < len(state.values) else state.values[0]


def _tempo_bpm(preset: Any) -> int:
    """Convert the QC tempo block's normalized value to its displayed BPM."""
    import pyquadcortex

    value = pyquadcortex.tempo_params(preset).get(0)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise RuntimeError("The active preset did not report a tempo value.")
    return round(MIN_TEMPO_BPM + (MAX_TEMPO_BPM - MIN_TEMPO_BPM) * float(value))


def _tempo_value(bpm: int) -> float:
    return (bpm - MIN_TEMPO_BPM) / (MAX_TEMPO_BPM - MIN_TEMPO_BPM)


def _normalized_mode(qc: Any) -> str:
    import pyquadcortex

    value = int(qc.mode().mode)
    if value in pyquadcortex.HYBRID_MODES:
        return "HYBRID"
    mode = pyquadcortex.describe_mode(value).upper()
    return mode if mode in {"PRESET", "SCENE", "STOMP"} else "PRESET"


def _footswitch_modes(qc: Any) -> list[str]:
    """Return the mode used by the physical top and bottom A-H switch rows."""
    import pyquadcortex

    value = int(qc.mode().mode)
    if value in pyquadcortex.HYBRID_MODES:
        return [mode.name for mode in pyquadcortex.HYBRID_MODES[value]]
    try:
        mode = pyquadcortex.FootswitchMode(value).name
    except ValueError:
        mode = "PRESET"
    return [mode, mode]


def _argb_to_css(value: int) -> str:
    """Convert the QC's ARGB uint32 scene color to an opaque CSS color."""
    return f"#{int(value) & 0xFFFFFF:06x}"


def _wait_for_dirty(qc: Any, expected: bool, timeout: float = 3.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if bool(qc.preset_dirty()) is expected:
            return True
        time.sleep(0.2)
    return bool(qc.preset_dirty()) is expected


class PyQuadCortexDevice:
    def __init__(self) -> None:
        self._qc: Any | None = None
        self._connected_at: str | None = None
        self._preset_cache: dict[str, list[dict[str, Any]]] = {}
        self._setlist_key: str | None = None
        self._preset_position: int | None = None
        self._setlist_is_factory = False

    @property
    def connected(self) -> bool:
        return self._qc is not None

    def close(self) -> None:
        qc, self._qc = self._qc, None
        self._connected_at = None
        self._preset_cache.clear()
        self._setlist_key = None
        self._preset_position = None
        self._setlist_is_factory = False
        if qc is not None:
            qc.close()

    def reconnect(self) -> dict[str, Any]:
        self.close()
        import pyquadcortex

        self._qc = pyquadcortex.connect()
        self._connected_at = _utc_now()
        self._remember_position(self._read_position_state())
        return self.connection_state("Quad Cortex handshake complete")

    def reset_session(self) -> dict[str, Any]:
        return self.reconnect()

    def disconnect(self) -> dict[str, Any]:
        self.close()
        return {
            "phase": "disconnected",
            "detail": "Quad Cortex session closed",
            "lastSync": _utc_now(),
            "demo": True,
        }

    def connection_state(self, detail: str | None = None) -> dict[str, Any]:
        if not self.connected:
            return {"phase": "disconnected", "detail": detail or "No active device session", "demo": False}
        return {
            "phase": "ready",
            "detail": detail or "Quad Cortex connected",
            "lastSync": self._connected_at,
            "demo": False,
        }

    def _require_session(self) -> Any:
        if self._qc is None:
            raise RuntimeError("No Quad Cortex session. Connect before using device controls.")
        return self._qc

    def _assert_expected_preset(self, expected_name: str) -> Any:
        qc = self._require_session()
        preset = qc.read_current_preset()
        if expected_name and preset.name != expected_name:
            raise RuntimeError(
                f"Preset changed on the Quad Cortex: expected {expected_name!r}, "
                f"but {preset.name or 'an unnamed preset'!r} is active. Refresh and retry."
            )
        return preset

    def _read_position_state(self, timeout: float = 10.0) -> Any:
        from pyquadcortex.proto import ProductionAutomation_pb2 as pa

        return self._require_session()._read_state(
            pa.SetlistPositionMessage,
            lambda message: message.HasField("position") and bool(message.folder_key),
            timeout,
        )

    def _remember_position(self, state: Any) -> None:
        self._setlist_key = state.folder_key
        self._preset_position = int(state.position)
        self._setlist_is_factory = bool(state.is_factory)

    def _current_position(self) -> tuple[str, int, bool]:
        if self._setlist_key is None or self._preset_position is None:
            self._remember_position(self._read_position_state())
        return self._setlist_key, self._preset_position, self._setlist_is_factory

    def list_presets(self, refresh: bool = False) -> dict[str, Any]:
        import pyquadcortex

        qc = self._require_session()
        setlist_key, current_position, _ = self._current_position()
        if refresh or setlist_key not in self._preset_cache:
            entries = qc.list_presets(setlist_key, timeout=25.0)
            self._preset_cache[setlist_key] = [
                {
                    "position": int(entry.index),
                    "location": pyquadcortex.position_to_slot(entry.index),
                    "name": entry.name,
                    "instrument": int(entry.instrument) if entry.HasField("instrument") else 0,
                }
                for entry in entries
            ]
        return {
            "setlistKey": setlist_key,
            "setlistName": setlist_key.rstrip("/").rsplit("/", 1)[-1],
            "currentPosition": current_position,
            "presets": self._preset_cache[setlist_key],
        }

    def list_preset_slots(self) -> dict[str, Any]:
        import pyquadcortex

        qc = self._require_session()
        setlist_key, current_position, is_factory = self._current_position()
        if is_factory:
            raise RuntimeError("Factory Library is read-only. Recall a user setlist before saving.")
        entries = qc.list_presets(setlist_key, timeout=25.0, include_empty=True)
        by_position = {
            int(entry.index): entry
            for entry in entries
            if entry.HasField("index")
        }
        slots = []
        for position in range(256):
            entry = by_position.get(position)
            name = entry.name if entry is not None and entry.HasField("name") else ""
            slots.append(
                {
                    "position": position,
                    "location": pyquadcortex.position_to_slot(position),
                    "name": name,
                    "occupied": bool(name),
                    "instrument": int(entry.instrument) if entry is not None and entry.HasField("instrument") else 0,
                }
            )
        return {
            "setlistKey": setlist_key,
            "setlistName": setlist_key.rstrip("/").rsplit("/", 1)[-1],
            "currentPosition": current_position,
            "slots": slots,
        }

    def list_models(self) -> dict[str, Any]:
        qc = self._require_session()
        models = [
            {
                "id": int(model.id),
                "name": model.name,
                "category": model.category,
                "basedOn": model.based_on,
            }
            for model in qc.catalog
            if not model.hidden and not model.internal and not model.category_hidden and not model.superseded
        ]
        models.sort(key=lambda model: (model["category"].casefold(), model["name"].casefold(), model["id"]))
        return {"models": models}

    def save_preset_as(
        self,
        setlist_key: str,
        position: int,
        name: str,
        expected_preset_name: str,
        expected_position: int,
        confirm_overwrite: bool,
    ) -> dict[str, Any]:
        import pyquadcortex

        if not isinstance(name, str) or not name.strip():
            raise ValueError("Preset name is required.")
        name = name.strip()
        if len(name) > 80:
            raise ValueError("Preset name must be 80 characters or fewer.")
        if not isinstance(confirm_overwrite, bool):
            raise ValueError("Overwrite confirmation must be true or false.")
        qc = self._require_session()
        current_key, current_position, is_factory = self._current_position()
        self._assert_expected_preset(expected_preset_name)
        if current_key != setlist_key or current_position != expected_position:
            raise RuntimeError("The active preset or setlist changed. Refresh and retry.")
        if is_factory:
            raise RuntimeError("Factory Library is read-only. Recall a user setlist before saving.")
        if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position < 256:
            raise ValueError("Preset position must be an integer from 0 through 255.")

        slots = self.list_preset_slots()["slots"]
        destination = slots[position]
        if destination["occupied"] and not confirm_overwrite:
            raise RuntimeError(
                f"Slot {destination['location']} contains {destination['name']!r}; explicit overwrite confirmation is required."
            )
        current_entry = next(
            (entry for entry in self.list_presets()["presets"] if entry["position"] == current_position),
            None,
        )
        instrument = current_entry["instrument"] if current_entry else 0
        active_scene = int(qc.active_scene())
        stored_name = qc.save_current_preset(
            setlist_key,
            position,
            name,
            instrument=instrument,
            default_scene=active_scene,
            confirm=True,
            confirm_timeout=25.0,
        )
        if not stored_name:
            raise RuntimeError("The device did not confirm the saved preset name.")
        recalled = qc.read_preset(setlist_key, position, timeout=15.0)
        if recalled.name != stored_name:
            raise RuntimeError("The saved slot did not read back with the confirmed name.")
        self._setlist_key = setlist_key
        self._preset_position = position
        self._preset_cache.pop(setlist_key, None)
        _wait_for_dirty(qc, False, timeout=3.0)
        snapshot = self.snapshot()
        if snapshot["presetName"] != stored_name or snapshot["dirty"]:
            raise RuntimeError("The preset saved, but final live-state verification failed.")
        return {
            "detail": f"Saved and verified {pyquadcortex.position_to_slot(position)} · {stored_name}",
            "savedName": stored_name,
            "snapshot": snapshot,
        }

    def _recall_position(
        self,
        setlist_key: str,
        position: int,
        expected_preset_name: str,
        expected_position: int | None = None,
    ) -> dict[str, Any]:
        import pyquadcortex

        if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position < 256:
            raise ValueError("Preset position must be an integer from 0 through 255.")
        qc = self._require_session()
        current_key, current_position, _ = self._current_position()
        self._assert_expected_preset(expected_preset_name)
        if expected_position is not None and current_position != expected_position:
            raise RuntimeError("The active preset slot changed on the Quad Cortex. Refresh and retry.")
        if current_key != setlist_key:
            raise RuntimeError("The active setlist changed on the Quad Cortex. Refresh and retry.")
        if qc.preset_dirty():
            raise RuntimeError("The current preset has unsaved changes. Save or revert them before recalling another preset.")

        listing = self.list_presets()["presets"]
        target = next((entry for entry in listing if entry["position"] == position), None)
        if target is None:
            raise RuntimeError(f"Preset slot {pyquadcortex.position_to_slot(position)} is empty.")
        recalled = qc.read_preset(setlist_key, position, timeout=15.0)
        if recalled.name != target["name"]:
            raise RuntimeError("Preset recall response did not match the target preset name.")
        self._setlist_key = setlist_key
        self._preset_position = position
        snapshot = self.snapshot()
        if snapshot["presetName"] != target["name"]:
            raise RuntimeError("Preset recall landed, but live preset readback did not match.")
        return {
            "detail": f"Recalled {target['location']} · {target['name']} and verified",
            "snapshot": snapshot,
        }

    def navigate_bank(
        self,
        direction: int,
        expected_preset_name: str,
        expected_position: int,
    ) -> dict[str, Any]:
        if isinstance(direction, bool) or direction not in (-1, 1):
            raise ValueError("Bank direction must be -1 or 1.")
        setlist_key, current_position, _ = self._current_position()
        target = current_position + direction * 8
        if not 0 <= target < 256:
            raise RuntimeError("Already at the first or last preset bank.")
        return self._recall_position(
            setlist_key, target, expected_preset_name, expected_position
        )

    def recall_preset(
        self,
        setlist_key: str,
        position: int,
        expected_preset_name: str,
        expected_position: int,
    ) -> dict[str, Any]:
        if not isinstance(setlist_key, str) or not setlist_key:
            raise ValueError("Setlist key is required.")
        return self._recall_position(
            setlist_key, position, expected_preset_name, expected_position
        )

    def reload_preset(
        self, expected_preset_name: str, expected_position: int
    ) -> dict[str, Any]:
        qc = self._require_session()
        setlist_key, current_position, _ = self._current_position()
        self._assert_expected_preset(expected_preset_name)
        if current_position != expected_position:
            raise RuntimeError("The active preset slot changed on the Quad Cortex. Refresh and retry.")
        recalled = qc.read_preset(setlist_key, current_position, timeout=15.0)
        if recalled.name != expected_preset_name:
            raise RuntimeError("Reload response did not match the expected preset.")
        deadline = time.monotonic() + 3.0
        while qc.preset_dirty() and time.monotonic() < deadline:
            time.sleep(0.2)
        snapshot = self.snapshot()
        if snapshot["dirty"]:
            raise RuntimeError("The preset reloaded, but the device still reports unsaved changes.")
        return {"detail": "Unsaved device changes discarded and preset reloaded", "snapshot": snapshot}

    def select_scene(self, scene: int, expected_preset_name: str = "") -> dict[str, Any]:
        if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < 8:
            raise ValueError("Scene must be an integer from 0 through 7.")
        qc = self._require_session()
        self._assert_expected_preset(expected_preset_name)
        qc.switch_scene(scene)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            if int(qc.active_scene()) == scene:
                return {
                    "detail": f"Scene {chr(65 + scene)} selected and verified",
                    "snapshot": self.snapshot(),
                }
            time.sleep(0.1)
        raise RuntimeError(f"Scene {chr(65 + scene)} did not verify after the device command.")

    def toggle_bypass(
        self,
        row: int,
        column: int,
        expected_scene: int,
        expected_bypassed: bool,
        desired_bypassed: bool,
        expected_preset_name: str = "",
    ) -> dict[str, Any]:
        for label, value, maximum in (("row", row, 3), ("column", column, 7), ("scene", expected_scene, 7)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if not isinstance(expected_bypassed, bool) or not isinstance(desired_bypassed, bool):
            raise ValueError("Expected and desired bypass states must be true or false.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        actual_scene = int(qc.active_scene())
        if actual_scene != expected_scene:
            raise RuntimeError(
                f"Scene changed on the Quad Cortex: expected {chr(65 + expected_scene)}, "
                f"but {chr(65 + actual_scene)} is active. Refresh and retry."
            )
        occupied = {(block.row, block.column) for block in pyquadcortex.blocks(preset)}
        if (row, column) not in occupied:
            raise RuntimeError(f"There is no block at row {row + 1}, column {column + 1}.")
        before = pyquadcortex.bypass_state(preset, row, column)
        before_value = before.scenes[expected_scene] if before.scene_mode else before.scenes[0]
        if before_value != expected_bypassed:
            raise RuntimeError(
                f"Bypass state changed on the Quad Cortex: expected {'bypassed' if expected_bypassed else 'enabled'}, "
                f"but it is {'bypassed' if before_value else 'enabled'}. Refresh and retry."
            )
        qc.set_bypass(row, column, desired_bypassed)

        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current = qc.read_current_preset()
            state = pyquadcortex.bypass_state(current, row, column)
            actual = state.scenes[expected_scene] if state.scene_mode else state.scenes[0]
            if actual == desired_bypassed:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Bypass readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"Block {'bypassed' if desired_bypassed else 'enabled'} and verified",
                    "snapshot": self.snapshot(),
                }
        raise RuntimeError("The bypass command was sent, but readback did not confirm the requested state.")

    def move_block(
        self,
        row: int,
        from_column: int,
        to_column: int,
        expected_model_id: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        """Move one existing block to an empty cell on the same signal row."""
        for label, value, maximum in (
            ("row", row, 3),
            ("source column", from_column, 7),
            ("destination column", to_column, 7),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if from_column == to_column:
            raise ValueError("Choose a different destination column.")
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id <= 0:
            raise ValueError("Expected model ID must be a positive integer.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        occupied = {(block.row, block.column): block for block in pyquadcortex.blocks(preset)}
        source = occupied.get((row, from_column))
        if source is None:
            raise RuntimeError(f"There is no block at row {row + 1}, column {from_column + 1}.")
        if int(source.model_id) != expected_model_id:
            raise RuntimeError("The source block changed on the Quad Cortex. Refresh and retry.")
        if (row, to_column) in occupied:
            raise RuntimeError(f"Row {row + 1}, column {to_column + 1} is no longer empty. Refresh and retry.")

        qc.move_block(row, from_column, row, to_column)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current = qc.read_current_preset()
            cells = {(block.row, block.column): block for block in pyquadcortex.blocks(current)}
            moved = cells.get((row, to_column))
            if (row, from_column) not in cells and moved is not None and int(moved.model_id) == expected_model_id:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Block move readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"Block moved to row {row + 1}, column {to_column + 1} and verified",
                    "snapshot": self.snapshot(),
                }
        raise RuntimeError("The move command was sent, but readback did not confirm the destination.")

    def add_block(
        self,
        row: int,
        column: int,
        model_id: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        for label, value, maximum in (("row", row, 3), ("column", column, 7)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if isinstance(model_id, bool) or not isinstance(model_id, int) or model_id <= 0:
            raise ValueError("Model ID must be a positive integer.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        if any(block.row == row and block.column == column for block in pyquadcortex.blocks(preset)):
            raise RuntimeError(f"Row {row + 1}, column {column + 1} is no longer empty. Refresh and retry.")
        model = qc.catalog.get(model_id)
        if model is None or model.hidden or model.internal or model.category_hidden or model.superseded:
            raise RuntimeError("The selected model is not available for new blocks on this Quad Cortex.")

        qc.set_block(row, column, model_id, verify=True, timeout=5.0)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current = qc.read_current_preset()
            placed = next(
                (block for block in pyquadcortex.blocks(current) if block.row == row and block.column == column),
                None,
            )
            if placed is not None and int(placed.model_id) == model_id:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Block placement readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"{model.name} placed at row {row + 1}, column {column + 1} and verified",
                    "snapshot": self.snapshot(),
                }
        raise RuntimeError("The block was accepted, but final preset readback did not confirm it.")

    def remove_block(
        self,
        row: int,
        column: int,
        expected_model_id: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        for label, value, maximum in (("row", row, 3), ("column", column, 7)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id <= 0:
            raise ValueError("Expected model ID must be a positive integer.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        block = next(
            (candidate for candidate in pyquadcortex.blocks(preset) if candidate.row == row and candidate.column == column),
            None,
        )
        if block is None or int(block.model_id) != expected_model_id:
            raise RuntimeError("The selected block changed on the Quad Cortex. Refresh and retry.")
        model = qc.catalog.get(expected_model_id)
        qc.remove_block(row, column)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current = qc.read_current_preset()
            if not any(item.row == row and item.column == column for item in pyquadcortex.blocks(current)):
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Block removal readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"{model.name if model else 'Block'} removed temporarily and verified",
                    "snapshot": self.snapshot(),
                }
        raise RuntimeError("The removal command was sent, but readback still reports the block.")

    def set_block_footswitch(
        self,
        row: int,
        column: int,
        footswitch: int | None,
        expected_footswitch: int | None,
        expected_model_id: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        """Assign or unassign a block's STOMP footswitch with stale-state guards."""
        for label, value, maximum in (("row", row, 3), ("column", column, 7)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        for label, value in (("footswitch", footswitch), ("expected footswitch", expected_footswitch)):
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < 8):
                raise ValueError(f"{label.capitalize()} must be null or an integer from 0 through 7.")
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id <= 0:
            raise ValueError("Expected model ID must be a positive integer.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        block = next(
            (candidate for candidate in pyquadcortex.blocks(preset) if candidate.row == row and candidate.column == column),
            None,
        )
        if block is None or int(block.model_id) != expected_model_id:
            raise RuntimeError("The selected block changed on the Quad Cortex. Refresh and retry.")
        current = next(
            (int(item.footswitch) for item in pyquadcortex.stomp_assignments(preset)
             if item.row == row and item.column == column),
            None,
        )
        if current != expected_footswitch:
            raise RuntimeError("The block's footswitch assignment changed on the Quad Cortex. Refresh and retry.")
        if footswitch == current:
            return {"detail": "Footswitch assignment was already current", "snapshot": self.snapshot()}

        if footswitch is None:
            qc.clear_stomp_assignment(row, column)
        else:
            qc.set_stomp_assignment(row, column, footswitch)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current_preset = qc.read_current_preset()
            actual = next(
                (int(item.footswitch) for item in pyquadcortex.stomp_assignments(current_preset)
                 if item.row == row and item.column == column),
                None,
            )
            if actual == footswitch:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Assignment readback matched, but the device did not mark the preset dirty.")
                label = "unassigned" if footswitch is None else f"assigned to Footswitch {chr(65 + footswitch)}"
                return {"detail": f"Block {label} and verified", "snapshot": self.snapshot()}
        raise RuntimeError("The assignment command was sent, but readback did not confirm the requested state.")

    def _set_chain_route(
        self,
        row: int,
        route_id: int,
        expected_route_id: int,
        expected_preset_name: str,
        route_kind: str,
    ) -> dict[str, Any]:
        labels = INPUT_ROUTE_LABELS if route_kind == "input" else OUTPUT_ROUTE_LABELS
        if isinstance(row, bool) or not isinstance(row, int) or not 0 <= row < 4:
            raise ValueError("Expected row must be an integer from 0 through 3.")
        for label, value in (("route", route_id), ("expected route", expected_route_id)):
            if isinstance(value, bool) or not isinstance(value, int) or value not in labels:
                raise ValueError(f"{label.capitalize()} is not a supported {route_kind} ID.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)

        def read_route(current_preset: Any) -> int:
            chain = next(
                (candidate for index, candidate in enumerate(current_preset.chains)
                 if (candidate.row if pyquadcortex.field_present(candidate, "row") else index) == row),
                None,
            )
            if chain is None:
                raise RuntimeError(f"Signal row {row + 1} is unavailable in the active preset.")
            field = "in_portid" if route_kind == "input" else "out_portid"
            return int(getattr(chain, field)) if pyquadcortex.field_present(chain, field) else 0

        if read_route(preset) != expected_route_id:
            raise RuntimeError(f"The row {route_kind} changed on the Quad Cortex. Refresh and retry.")
        if route_id == expected_route_id:
            return {"detail": f"Row {row + 1} {route_kind} was already current", "snapshot": self.snapshot()}

        if route_kind == "input":
            qc.set_chain_input(row, route_id)
        else:
            qc.set_chain_output(row, route_id)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            if read_route(qc.read_current_preset()) == route_id:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Routing readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"Row {row + 1} {route_kind} set to {labels[route_id]} and verified",
                    "snapshot": self.snapshot(),
                }
        raise RuntimeError(f"The {route_kind} command was sent, but readback did not confirm the requested route.")

    def set_chain_input(
        self, row: int, input_id: int, expected_input_id: int, expected_preset_name: str
    ) -> dict[str, Any]:
        return self._set_chain_route(row, input_id, expected_input_id, expected_preset_name, "input")

    def set_chain_output(
        self, row: int, output_id: int, expected_output_id: int, expected_preset_name: str
    ) -> dict[str, Any]:
        return self._set_chain_route(row, output_id, expected_output_id, expected_preset_name, "output")

    def set_chain_split(
        self,
        row: int,
        split_column: int | None,
        mix_column: int | None,
        expected_split_column: int | None,
        expected_mix_column: int | None,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        if isinstance(row, bool) or row not in (0, 2):
            raise ValueError("Parallel routing is available only on rows 1 and 3.")

        def validate_pair(split: int | None, mix: int | None, label: str) -> None:
            if split is None:
                if mix is not None:
                    raise ValueError(f"{label} mix column must be null when the split is disabled.")
                return
            if isinstance(split, bool) or not isinstance(split, int) or not 0 <= split < 8:
                raise ValueError(f"{label} split column must be null or an integer from 0 through 7.")
            if isinstance(mix, bool) or not isinstance(mix, int) or mix not in range(-1, 8):
                raise ValueError(f"{label} mix column must be -1 or an integer from 0 through 7.")
            if mix != -1 and mix <= split:
                raise ValueError(f"{label} rejoin column must follow the split column.")

        validate_pair(split_column, mix_column, "Requested")
        validate_pair(expected_split_column, expected_mix_column, "Expected")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)

        def read_split(current_preset: Any) -> tuple[int | None, int | None]:
            split = next((item for item in pyquadcortex.splits(current_preset) if item.row == row), None)
            return (None, None) if split is None else (int(split.split_column), int(split.mix_column))

        expected = (expected_split_column, expected_mix_column)
        desired = (split_column, mix_column)
        if read_split(preset) != expected:
            raise RuntimeError("The parallel route changed on the Quad Cortex. Refresh and retry.")
        if desired == expected:
            return {"detail": f"Row {row + 1} parallel route was already current", "snapshot": self.snapshot()}

        if split_column is None:
            qc.clear_split(row)
        else:
            qc.set_split(row, split_column, mix_column)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            if read_split(qc.read_current_preset()) == desired:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Parallel-route readback matched, but the device did not mark the preset dirty.")
                detail = (
                    f"Row {row + 1} returned to a serial path and verified"
                    if split_column is None
                    else f"Row {row + 1} branch and rejoin routing updated and verified"
                )
                return {"detail": detail, "snapshot": self.snapshot()}
        raise RuntimeError("The parallel-routing command was sent, but readback did not confirm it.")

    def block_details(
        self, row: int, column: int, expected_preset_name: str = ""
    ) -> dict[str, Any]:
        for label, value, maximum in (("row", row, 3), ("column", column, 7)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        scene = int(qc.active_scene())
        block = next(
            (candidate for candidate in pyquadcortex.blocks(preset) if candidate.row == row and candidate.column == column),
            None,
        )
        if block is None:
            raise RuntimeError(f"There is no block at row {row + 1}, column {column + 1}.")
        model = qc.catalog.get(block.model_id)
        if model is None:
            raise RuntimeError(f"Model metadata is unavailable for block {block.model_id}.")

        parameters = []
        for spec in model.parameters:
            try:
                state = pyquadcortex.param_state(preset, row, column, spec.index)
                value = _effective_parameter_value(state, scene)
            except (IndexError, AttributeError):
                continue
            options = pyquadcortex.param_options(preset, row, column, spec.index)
            writable = isinstance(value, (int, float)) and not isinstance(value, bool)
            display_value: str
            if options and writable:
                try:
                    display_value = str(pyquadcortex.option_at(options, float(value)))
                except (ValueError, IndexError):
                    display_value = f"{float(value):.3f}"
            elif writable:
                try:
                    display_value = f"{spec.to_real(float(value)):.3f}".rstrip("0").rstrip(".")
                except ValueError:
                    display_value = f"{float(value):.3f}".rstrip("0").rstrip(".")
            else:
                display_value = str(value or "")
            parameters.append(
                {
                    "index": spec.index,
                    "name": spec.name or f"Parameter {spec.index}",
                    "normalizedValue": float(value) if writable else None,
                    "displayValue": display_value,
                    "units": spec.units,
                    "type": spec.type,
                    "minimum": spec.minimum,
                    "maximum": spec.maximum,
                    "steps": spec.steps,
                    "sceneMode": bool(state.scene_mode),
                    "options": list(options),
                    "writable": writable,
                }
            )
        return {
            "row": row,
            "column": column,
            "modelId": block.model_id,
            "name": model.name,
            "category": model.category,
            "scene": scene,
            "parameters": parameters,
        }

    def set_parameter(
        self,
        row: int,
        column: int,
        parameter_index: int,
        value: float,
        expected_value: float,
        expected_scene: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0.0 <= value <= 1.0:
            raise ValueError("Parameter value must be a normalized number from 0 through 1.")
        if isinstance(expected_value, bool) or not isinstance(expected_value, (int, float)):
            raise ValueError("Expected parameter value must be numeric.")
        if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
            raise ValueError("Parameter index must be a non-negative integer.")

        import pyquadcortex

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        actual_scene = int(qc.active_scene())
        if actual_scene != expected_scene:
            raise RuntimeError(
                f"Scene changed on the Quad Cortex: expected {chr(65 + expected_scene)}, "
                f"but {chr(65 + actual_scene)} is active. Refresh and retry."
            )
        block = next(
            (candidate for candidate in pyquadcortex.blocks(preset) if candidate.row == row and candidate.column == column),
            None,
        )
        if block is None:
            raise RuntimeError(f"There is no block at row {row + 1}, column {column + 1}.")
        model = qc.catalog.get(block.model_id)
        if model is None or not any(spec.index == parameter_index for spec in model.parameters):
            raise RuntimeError("The selected block no longer exposes that parameter.")
        state = pyquadcortex.param_state(preset, row, column, parameter_index)
        current = _effective_parameter_value(state, actual_scene)
        if not isinstance(current, (int, float)) or isinstance(current, bool):
            raise RuntimeError("This parameter is not numeric and cannot be changed by this editor.")
        options = pyquadcortex.param_options(preset, row, column, parameter_index)
        if not pyquadcortex.params_equal(float(current), float(expected_value), len(options) or None):
            raise RuntimeError("The parameter changed on the Quad Cortex. Refresh the block and retry.")

        qc.set_param(row, column, param_index=parameter_index, value=float(value))
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current_preset = qc.read_current_preset()
            current_state = pyquadcortex.param_state(current_preset, row, column, parameter_index)
            actual = _effective_parameter_value(current_state, actual_scene)
            if isinstance(actual, (int, float)) and pyquadcortex.params_equal(
                float(actual), float(value), len(options) or None
            ):
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Parameter readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": "Parameter change applied and verified",
                    "block": self.block_details(row, column, expected_preset_name),
                    "snapshot": self.snapshot(),
                }
        raise RuntimeError("The parameter command was sent, but readback did not confirm the requested value.")

    def set_tempo(
        self,
        bpm: int,
        expected_tempo: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        import pyquadcortex

        if isinstance(bpm, bool) or not isinstance(bpm, int) or not MIN_TEMPO_BPM <= bpm <= MAX_TEMPO_BPM:
            raise ValueError(f"Tempo must be an integer from {MIN_TEMPO_BPM} through {MAX_TEMPO_BPM} BPM.")
        if (
            isinstance(expected_tempo, bool)
            or not isinstance(expected_tempo, int)
            or not MIN_TEMPO_BPM <= expected_tempo <= MAX_TEMPO_BPM
        ):
            raise ValueError(f"Expected tempo must be an integer from {MIN_TEMPO_BPM} through {MAX_TEMPO_BPM} BPM.")

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        actual_bpm = _tempo_bpm(preset)
        if actual_bpm != expected_tempo:
            raise RuntimeError(
                f"Tempo changed on the Quad Cortex: expected {expected_tempo} BPM, "
                f"but it is {actual_bpm} BPM. Refresh and retry."
            )
        if bpm == actual_bpm:
            return {"detail": f"Tempo is already {bpm} BPM", "snapshot": self.snapshot()}

        desired_value = _tempo_value(bpm)
        qc.set_tempo_param("TEMPO", value=desired_value)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current = qc.read_current_preset()
            actual_value = pyquadcortex.tempo_params(current).get(0)
            if isinstance(actual_value, (int, float)) and abs(float(actual_value) - desired_value) <= 0.0025:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Tempo readback matched, but the device did not mark the preset dirty.")
                snapshot = self.snapshot()
                if snapshot["tempo"] != bpm:
                    raise RuntimeError("Tempo write landed, but its displayed BPM did not verify.")
                return {"detail": f"Tempo set to {bpm} BPM and verified", "snapshot": snapshot}
        raise RuntimeError("The tempo command was sent, but readback did not confirm the requested BPM.")

    def set_master_volume(self, value: int, expected_value: int) -> dict[str, Any]:
        """Set the live QC master volume using its displayed 0-100 scale."""
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            raise ValueError("Master Volume must be an integer from 0 through 100.")
        if isinstance(expected_value, bool) or not isinstance(expected_value, int) or not 0 <= expected_value <= 100:
            raise ValueError("Expected Master Volume must be an integer from 0 through 100.")

        qc = self._require_session()
        actual = round(float(qc.master_volume(timeout=3.0).volume) * 100)
        if abs(actual - expected_value) > 1:
            raise RuntimeError(
                f"Master Volume changed on the Quad Cortex: expected {expected_value}, found {actual}. "
                "The current device value has been restored in QC Control."
            )
        if actual == value:
            return {"detail": f"Master Volume is already {value}", "snapshot": self.snapshot()}

        qc.set_master_volume(value / 100.0)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.15)
            confirmed = round(float(qc.master_volume(timeout=3.0).volume) * 100)
            if abs(confirmed - value) <= 1:
                snapshot = self.snapshot()
                snapshot["masterVolume"] = confirmed
                return {
                    "detail": f"Master Volume set to {confirmed}; the physical wheel will resume after soft takeover",
                    "snapshot": snapshot,
                }
        raise RuntimeError("The Master Volume command was sent, but readback did not confirm the requested value.")

    def press_footswitch(
        self,
        index: int,
        expected_mode: str,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        import pyquadcortex

        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < 8:
            raise ValueError("Footswitch must be an integer from 0 through 7.")
        if expected_mode not in {"PRESET", "SCENE", "STOMP", "HYBRID"}:
            raise ValueError("Expected mode must be PRESET, SCENE, STOMP, or HYBRID.")

        qc = self._require_session()
        self._assert_expected_preset(expected_preset_name)
        actual_mode = _normalized_mode(qc)
        if actual_mode != expected_mode:
            raise RuntimeError(
                f"Footswitch mode changed on the Quad Cortex: expected {expected_mode}, "
                f"but it is {actual_mode}. Refresh and retry."
            )
        if actual_mode == "PRESET" and qc.preset_dirty():
            raise RuntimeError("The current preset has unsaved changes. Save or revert them before pressing a preset footswitch.")

        before = self.snapshot()
        endpoint = _send_qc_midi_cc(35 + index)
        time.sleep(0.35)
        try:
            self._remember_position(self._read_position_state(timeout=5.0))
        except TimeoutError:
            pass
        after = self.snapshot()
        label = chr(65 + index)
        if actual_mode == "SCENE" and after["activeScene"] != index:
            raise RuntimeError(f"Footswitch {label} was sent, but Scene {label} did not verify.")
        if actual_mode == "PRESET":
            target_position = (before["presetPosition"] // 8) * 8 + index
            if after["presetPosition"] != target_position:
                raise RuntimeError(f"Footswitch {label} was sent, but its bank preset did not verify.")
        changed = (
            before["presetPosition"] != after["presetPosition"]
            or before["activeScene"] != after["activeScene"]
            or [(block["id"], block["bypassed"]) for block in before["blocks"]]
            != [(block["id"], block["bypassed"]) for block in after["blocks"]]
        )
        detail = f"Footswitch {label} pressed through {endpoint}"
        if changed:
            detail += " and resulting device state verified"
        else:
            detail += "; no visible assignment changed"
        return {"detail": detail, "snapshot": after}

    def show_tuner(self, shown: bool = True) -> dict[str, Any]:
        if not isinstance(shown, bool):
            raise ValueError("Tuner visibility must be true or false.")
        self._require_session().show_tuner(shown)
        return {"detail": "Tuner opened on the Quad Cortex" if shown else "Tuner closed"}

    def show_gig_view(self, shown: bool = True) -> dict[str, Any]:
        if not isinstance(shown, bool):
            raise ValueError("Gig View visibility must be true or false.")
        self._require_session().set_gig_view(shown)
        return {"detail": "Gig View opened on the Quad Cortex" if shown else "Gig View closed"}

    def snapshot(self) -> dict[str, Any]:
        import pyquadcortex

        qc = self._require_session()
        preset = qc.read_current_preset()
        setlist_key, preset_position, _ = self._current_position()
        active_scene = int(qc.active_scene())
        mode = _normalized_mode(qc)
        footswitch_modes = _footswitch_modes(qc)
        master_volume = round(float(qc.master_volume(timeout=3.0).volume) * 100)

        catalog = qc.catalog
        stomp_assignments = list(pyquadcortex.stomp_assignments(preset))
        stomp_by_cell = {
            (assignment.row, assignment.column): int(assignment.footswitch)
            for assignment in stomp_assignments
        }
        stomp_order_by_cell = {
            (assignment.row, assignment.column): order
            for order, assignment in enumerate(stomp_assignments)
        }
        blocks = []
        for block in pyquadcortex.blocks(preset):
            model = catalog.get(block.model_id)
            category = model.category if model else "Utility"
            try:
                bypass = pyquadcortex.bypass_state(preset, block.row, block.column)
                bypassed = bypass.scenes[active_scene] if bypass.scene_mode else bypass.scenes[0]
            except (IndexError, AttributeError):
                bypassed = False
            blocks.append({
                "id": f"block-{block.row}-{block.column}",
                "modelId": int(block.model_id),
                "categoryId": int(model.category_id) if model else -1,
                "name": model.name if model else f"Model {block.model_id}",
                "kind": _block_kind(category),
                "category": category,
                "row": block.row,
                "column": block.column,
                "bypassed": bypassed,
                "color": _block_color(category, model.name if model else ""),
                "footswitch": stomp_by_cell.get((block.row, block.column)),
                "footswitchOrder": stomp_order_by_cell.get((block.row, block.column)),
            })

        block_by_cell = {(block["row"], block["column"]): block for block in blocks}
        momentary = dict(preset.stomp_is_momentary)
        stomp_labels = dict(preset.stomp_labels)
        single_stomp_labels = dict(preset.single_stomp_labels)
        footswitch_states = []
        for index in range(8):
            targets = [
                block_by_cell.get((assignment.row, assignment.column))
                for assignment in stomp_assignments
                if int(assignment.footswitch) == index
            ]
            targets = [target for target in targets if target is not None]
            # CorOS keys a multi-block STOMP's lamp phase and color to the first
            # assigned block. Using any(target enabled) breaks inverted groups:
            # their members swap states, so at least one is always enabled.
            leader = targets[0] if targets else None
            footswitch_states.append({
                "index": index,
                "active": bool(leader is not None and not leader["bypassed"]),
                "assigned": bool(targets),
                "color": _stomp_color(targets),
                "momentary": bool(momentary.get(index, False)),
                "label": single_stomp_labels.get(index) or stomp_labels.get(index) or "",
            })

        split_by_row = {split.row: split for split in pyquadcortex.splits(preset)}
        routes = []
        for index, chain in enumerate(preset.chains):
            row = chain.row if pyquadcortex.field_present(chain, "row") else index
            input_id = int(chain.in_portid) if pyquadcortex.field_present(chain, "in_portid") else 0
            output_id = int(chain.out_portid) if pyquadcortex.field_present(chain, "out_portid") else 0
            route = {
                "row": row,
                "inputId": input_id,
                "outputId": output_id,
                "input": INPUT_ROUTE_LABELS.get(input_id, f"Input {input_id}"),
                "output": OUTPUT_ROUTE_LABELS.get(output_id, f"Output {output_id}"),
            }
            split = split_by_row.get(row)
            if split is not None:
                route["splitColumn"] = split.split_column
                route["mixColumn"] = split.mix_column
            routes.append(route)

        labels = list(preset.scene_labels)
        scenes = [(labels[index] if index < len(labels) and labels[index] else f"Scene {chr(65 + index)}") for index in range(8)]
        tempo_values = pyquadcortex.tempo_params(preset)
        return {
            "deviceName": "Quad Cortex",
            "presetName": preset.name or "Current preset",
            "presetLocation": pyquadcortex.position_to_slot(preset_position),
            "presetPosition": preset_position,
            "setlistKey": setlist_key,
            "setlistName": setlist_key.rstrip("/").rsplit("/", 1)[-1],
            "mode": mode,
            "footswitchModes": footswitch_modes,
            "activeScene": active_scene,
            "scenes": scenes,
            "sceneColors": [_argb_to_css(color) for color in list(preset.scene_colors)[:8]],
            "footswitchStates": footswitch_states,
            "blocks": blocks,
            "routes": routes,
            "tempo": _tempo_bpm(preset),
            "tempoLedEnabled": tempo_values.get(2, 0.0) >= 0.5,
            "masterVolume": master_volume,
            "dirty": bool(qc.preset_dirty()),
        }
