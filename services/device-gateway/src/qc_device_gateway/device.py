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

        catalog = qc.catalog
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
                "name": model.name if model else f"Model {block.model_id}",
                "kind": _block_kind(category),
                "row": block.row,
                "column": block.column,
                "bypassed": bypassed,
            })

        split_by_row = {split.row: split for split in pyquadcortex.splits(preset)}
        routes = []
        for index, chain in enumerate(preset.chains):
            row = chain.row if pyquadcortex.field_present(chain, "row") else index
            input_id = int(chain.in_portid) if pyquadcortex.field_present(chain, "in_portid") else 0
            output_id = int(chain.out_portid) if pyquadcortex.field_present(chain, "out_portid") else 0
            route = {
                "row": row,
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
        return {
            "deviceName": "Quad Cortex",
            "presetName": preset.name or "Current preset",
            "presetLocation": pyquadcortex.position_to_slot(preset_position),
            "presetPosition": preset_position,
            "setlistKey": setlist_key,
            "setlistName": setlist_key.rstrip("/").rsplit("/", 1)[-1],
            "mode": mode,
            "activeScene": active_scene,
            "scenes": scenes,
            "blocks": blocks,
            "routes": routes,
            "tempo": _tempo_bpm(preset),
            "dirty": bool(qc.preset_dirty()),
        }
