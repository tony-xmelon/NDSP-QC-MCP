"""Development parity adapter owned exclusively by the Python gateway process."""

from __future__ import annotations

import base64
from datetime import datetime, timezone
import json
import math
import re
import time
from typing import Any

from .domain import CATEGORY_COLORS, GRID_COLUMNS, GRID_ROWS, HARDWARE_COLORS, INPUT_ROUTE_LABELS, MAXIMUM_TEMPO_BPM, MINIMUM_TEMPO_BPM, OUTPUT_ROUTE_LABELS, SCENE_COUNT
from .generated_payloads import BlockDetails, DeviceActionResult, PresetSnapshot
from .usb_profile import FOOTSWITCH_BASE_CONTROLLER, MIDI_PRESSED_VALUE, MODE_SLOT_CONTROLLER, TAP_TEMPO_CONTROLLER


MIN_TEMPO_BPM = MINIMUM_TEMPO_BPM
MAX_TEMPO_BPM = MAXIMUM_TEMPO_BPM


def _protocol_api():
    """Return the stable message-level API across pyquadcortex 0.40/0.41."""
    import pyquadcortex

    return getattr(pyquadcortex, "protocol", pyquadcortex)


def _protocol_symbol(name: str, module: str):
    """Resolve symbols exported by newer protocol facades with legacy fallback."""
    protocol = _protocol_api()
    exported = getattr(protocol, name, None)
    if exported is not None:
        return exported

    from importlib import import_module

    return getattr(import_module(f"{protocol.__name__}.{module}"), name)


def _production_automation_proto():
    protocol = _protocol_api()
    from importlib import import_module

    return import_module(f"{protocol.__name__}.proto.ProductionAutomation_pb2")


def _parse_model_repo(payload: bytes):
    protocol = _protocol_api()
    from importlib import import_module

    return import_module(f"{protocol.__name__}.catalog").parse_model_repo(payload)


def _native_transport_method(qc: Any, name: str):
    """Return an intent-level Rust broker operation when that host provides it."""
    return getattr(getattr(qc, "_t", None), name, None)


def _pyquadcortex_method(qc: Any, name: str):
    """Require a public pyquadcortex operation supplied by the parity PRs."""
    method = getattr(qc, name, None)
    if method is None:
        raise RuntimeError(
            f"Installed pyquadcortex does not provide {name}(); upgrade to a release "
            "that includes the identity/history, screenshot, and remote-screen APIs."
        )
    return method


def _optional_finite_range(value: Any, name: str, minimum: float, maximum: float) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number or null")
    result = float(value)
    if not minimum <= result <= maximum:
        raise ValueError(f"{name} must be from {minimum:g} through {maximum:g}")
    return result


def _png_response(image: bytes) -> dict[str, Any]:
    """Project pyquadcortex image bytes to the shared Rust gateway shape."""
    payload = bytes(image)
    if (
        len(payload) < 24
        or not payload.startswith(b"\x89PNG\r\n\x1a\n")
        or payload[12:16] != b"IHDR"
    ):
        raise RuntimeError("The Quad Cortex response was not a valid PNG image.")
    return {
        "pngBase64": base64.b64encode(payload).decode("ascii"),
        "width": int.from_bytes(payload[16:20], "big"),
        "height": int.from_bytes(payload[20:24], "big"),
    }

ROUTING_NODE_COLUMNS = {8: "splitter", 9: "mixer"}
ROUTING_NODE_MODELS = {"splitter": 10004, "mixer": 11000}
ROUTING_PARAMETER_OPTIONS = {
    ("splitter", 0): ["A/B", "BALANCE", "CROSSOVER"],
    ("splitter", 1): ["MONO", "STEREO"],
    ("splitter", 6): ["LOW / HIGH", "HIGH / LOW"],
    ("mixer", 4): ["NORMAL", "INVERTED"],
}

_UK_C30_65_MICROPHONES = (
    "Condenser 184", "Condenser 414", "Dynamic 421",
    "Dynamic 57", "Ribbon 10", "Ribbon 160",
)


def _cab_microphone_options(model_id: int, value: Any) -> list[str]:
    """Return the factory mic files the QC exposes for the UK C30 65 cab."""
    if int(model_id) not in (12024, 32024) or not isinstance(value, str) or "_" not in value:
        return []
    prefix = value.rsplit("_", 1)[0]
    return [f"{prefix}_{microphone}" for microphone in _UK_C30_65_MICROPHONES]

_FACTORY_CATEGORY_NAMES = {
    "BassAmplifier": "Bass Amp",
    "BassOverdrive": "Bass Overdrive",
    "CabsimBassM": "Bass Cab",
    "CabsimBassST": "Bass Cab",
    "CabsimGuitarM": "Guitar Cab",
    "CabsimGuitarST": "Guitar Cab",
    "FXLoop": "FX Loop",
    "GuitarAmplifier": "Guitar Amp",
    "GuitarOverdrive": "Guitar Overdrive",
    "IRLoaders": "IR Loader",
    "Loopers": "Looper",
}
_DEVICE_TYPE_NAMES = {
    "bassamplifier": "Bass Amp", "bassamp": "Bass Amp",
    "bassoverdrive": "Bass Overdrive",
    "cabsimbassm": "Bass Cab", "cabsimbassst": "Bass Cab",
    "basscabinet": "Bass Cab", "basscab": "Bass Cab",
    "cabsimguitarm": "Guitar Cab", "cabsimguitarst": "Guitar Cab",
    "guitarcabinet": "Guitar Cab", "guitarcab": "Guitar Cab",
    "compressor": "Compressor", "delay": "Delay", "equalizer": "EQ", "eq": "EQ",
    "filter": "Filter", "fxloop": "FX Loop",
    "guitaramplifier": "Guitar Amp", "guitaramp": "Guitar Amp", "amp": "Guitar Amp",
    "guitaroverdrive": "Guitar Overdrive", "irloaders": "IR Loader", "irloader": "IR Loader",
    "loopers": "Looper", "looper": "Looper", "modulation": "Modulation",
    "morph": "Morph", "neuralcapture": "Neural Capture", "pitch": "Pitch",
    "reverb": "Reverb", "synth": "Synth", "utility": "Utility", "wah": "Wah",
}
_factory_model_cache: dict[int, tuple[str, str]] | None = None


def _device_type_name(category: str) -> str:
    key = re.sub(r"[^a-z0-9]+", "", category.casefold())
    return _DEVICE_TYPE_NAMES.get(key, category.strip())


def _format_parameter_number(value: float, precision: int | None) -> str:
    rendered = f"{value:.{precision}f}" if precision is not None else f"{value:.3f}".rstrip("0").rstrip(".")
    # Floating-point conversion can leave a negative residue that rounds to
    # zero. CorOS displays zero without a sign (0.0 dB, never -0.0 dB).
    return rendered[1:] if rendered.startswith("-") and float(rendered) == 0 else rendered


def _factory_model_metadata(model_id: int) -> tuple[str, str] | None:
    """Resolve built-in model labels without starting a device catalog transfer."""
    global _factory_model_cache
    if _factory_model_cache is None:
        from pyquadcortex import models

        _factory_model_cache = {}
        for qualified_name, value in models.ALL.items():
            category_key, constant = qualified_name.split(".", 1)
            category = _device_type_name(_FACTORY_CATEGORY_NAMES.get(
                category_key,
                re.sub(r"(?<!^)(?=[A-Z])", " ", category_key),
            ))
            name = constant.removeprefix("N").replace("_", " ").title()
            _factory_model_cache.setdefault(int(value), (name, category))
    return _factory_model_cache.get(int(model_id))


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
    if "plugin" in value:
        return CATEGORY_COLORS["plugin"]
    if "capture" in value:
        return CATEGORY_COLORS["capture"]
    if "amplifier" in value or value.endswith(" amp"):
        return CATEGORY_COLORS["amp"]
    if "looper" in value:
        return CATEGORY_COLORS["looper"]
    if "ir loader" in value or "irloader" in value:
        return CATEGORY_COLORS["irLoader"]
    if "cab" in value or "impulse response" in value:
        return CATEGORY_COLORS["cab"]
    if any(term in value for term in ("overdrive", "distortion", "drive", "boost", "fuzz")):
        return CATEGORY_COLORS["overdrive"]
    if "delay" in value:
        return CATEGORY_COLORS["delay"]
    if "reverb" in value:
        return CATEGORY_COLORS["reverb"]
    if "compressor" in value:
        return CATEGORY_COLORS["compressor"]
    if "pitch" in value or "octav" in model:
        return CATEGORY_COLORS["pitch"]
    if "modulation" in value:
        return CATEGORY_COLORS["modulation"]
    if "morph" in value or "filter" in value:
        return CATEGORY_COLORS["morph"]
    if "synth" in value:
        return CATEGORY_COLORS["synth"]
    if "equalizer" in value or value == "eq":
        return CATEGORY_COLORS["equalizer"]
    if "gate" in model or "utility" in value or "wah" in value or "fx loop" in value:
        return CATEGORY_COLORS["utility"]
    return CATEGORY_COLORS["utility"]


def _stomp_color(targets: list[dict[str, Any]]) -> str:
    """Return the physical STOMP lamp color (not the Grid block color)."""
    if len(targets) > 1:
        return HARDWARE_COLORS["whiteLed"]
    if not targets:
        return HARDWARE_COLORS["idleLed"]
    target = targets[0]
    category = str(target.get("category", target.get("kind", ""))).casefold()
    if any(term in category for term in ("overdrive", "distortion", "drive", "boost", "fuzz")):
        return CATEGORY_COLORS["pitch"]
    category_color = _block_color(
        category,
        str(target.get("name", "")),
    )
    return HARDWARE_COLORS["whiteLed"] if category_color == CATEGORY_COLORS["utility"] else category_color


def _effective_parameter_value(state: Any, scene: int) -> Any:
    if not state.values:
        return None
    return state.values[scene] if state.scene_mode and scene < len(state.values) else state.values[0]


def _editor_parameter_state(value: Any, options: list[str], parameter_type: str) -> tuple[float | None, bool]:
    """Translate numeric and dynamic text values into the editor's 0..1 domain."""
    numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
    if numeric:
        return float(value), parameter_type != "grMeter"
    if isinstance(value, str) and options and value in options:
        normalized = 0.0 if len(options) == 1 else options.index(value) / (len(options) - 1)
        return normalized, True
    return None, False


_SUPPORTED_PARAMETER_TYPES = {
    "comboBox", "empty", "fader", "float", "floatWithLed", "grMeter",
    "int", "rotarySwitch", "string", "switch", "toggleButton",
}


def _catalog_audit(models: Any) -> dict[str, Any]:
    """Check every visible runtime model and parameter the editor may receive."""
    exceptions: list[dict[str, Any]] = []
    model_count = parameter_count = 0
    categories: set[str] = set()
    for model in models:
        if model.hidden or model.internal or model.category_hidden or model.superseded:
            continue
        model_count += 1
        categories.add(model.category)
        seen_indexes: set[int] = set()
        for parameter in model.parameters:
            parameter_count += 1
            issue = ""
            if parameter.index in seen_indexes:
                issue = f"duplicate parameter index {parameter.index}"
            elif not parameter.name.strip():
                issue = "parameter name is empty"
            elif parameter.type not in _SUPPORTED_PARAMETER_TYPES:
                issue = f"unsupported parameter type {parameter.type!r}"
            elif parameter.steps is not None and parameter.steps < 1:
                issue = f"invalid step count {parameter.steps}"
            seen_indexes.add(parameter.index)
            if issue:
                exceptions.append({
                    "modelId": int(model.id),
                    "modelName": model.name,
                    "parameterIndex": int(parameter.index),
                    "issue": issue,
                })
    return {
        "modelCount": model_count,
        "parameterCount": parameter_count,
        "categoryCount": len(categories),
        "exceptions": exceptions,
    }


def _tempo_bpm(preset: Any) -> int:
    """Convert the QC tempo block's normalized value to its displayed BPM."""
    pyquadcortex = _protocol_api()

    value = pyquadcortex.tempo_params(preset).get(0)
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise RuntimeError("The active preset did not report a tempo value.")
    return round(MIN_TEMPO_BPM + (MAX_TEMPO_BPM - MIN_TEMPO_BPM) * float(value))


def _tempo_value(bpm: int) -> float:
    return (bpm - MIN_TEMPO_BPM) / (MAX_TEMPO_BPM - MIN_TEMPO_BPM)


def _normalized_mode_value(value: int) -> str:
    pyquadcortex = _protocol_api()

    if value in pyquadcortex.HYBRID_MODES:
        return "HYBRID"
    mode = pyquadcortex.describe_mode(value).upper()
    return mode if mode in {"PRESET", "SCENE", "STOMP"} else "PRESET"


def _normalized_mode(qc: Any) -> str:
    return _normalized_mode_value(int(qc.mode().mode))


def _footswitch_modes_value(value: int) -> list[str]:
    """Return the mode used by the physical top and bottom A-H switch rows."""
    pyquadcortex = _protocol_api()

    if value in pyquadcortex.HYBRID_MODES:
        return [mode.name for mode in pyquadcortex.HYBRID_MODES[value]]
    try:
        mode = pyquadcortex.FootswitchMode(value).name
    except ValueError:
        mode = "PRESET"
    return [mode, mode]


def _footswitch_modes(qc: Any) -> list[str]:
    return _footswitch_modes_value(int(qc.mode().mode))


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


def _conditional_parameter_hidden(model_id: int, parameter_index: int, normalized_values: dict[int, float | None]) -> bool:
    """Resolve controls that intentionally share one ModelRepo display slot."""
    if int(model_id) != 18007:  # Minivoicer
        return False
    quantized = float(normalized_values.get(4) or 0.0) >= 0.5
    return parameter_index in ({20, 21} if quantized else {7, 11})


def _parameter_enabled(
    metadata: dict[str, Any],
    normalized_values: dict[int, float | None],
    controller_steps: dict[int, int | None],
) -> bool:
    """Evaluate ModelRepo toggleOn/toggleOff/toggleStep dependencies."""
    allowed_steps = set(int(item) for item in metadata.get("enableWhenSteps") or [])

    def selected_step(controller: int, value: float) -> int:
        count = controller_steps.get(controller) or 2
        return round(max(0.0, min(1.0, value)) * max(1, count - 1))

    enable_when_on = metadata.get("enableWhenOn")
    if enable_when_on is not None:
        value = normalized_values.get(int(enable_when_on))
        if value is None:
            return False
        if allowed_steps:
            if selected_step(int(enable_when_on), float(value)) not in allowed_steps:
                return False
        elif float(value) < 0.5:
            return False

    enable_when_off = metadata.get("enableWhenOff")
    if enable_when_off is not None:
        value = normalized_values.get(int(enable_when_off))
        if value is None:
            return False
        if allowed_steps:
            if selected_step(int(enable_when_off), float(value)) in allowed_steps:
                return False
        elif float(value) >= 0.5:
            return False
    return True


class PyQuadCortexDevice:
    def __init__(self) -> None:
        self._qc: Any | None = None
        self._connected_at: str | None = None
        self._preset_cache: dict[str, list[dict[str, Any]]] = {}
        self._preset_folder_cache: list[dict[str, Any]] | None = None
        self._setlist_key: str | None = None
        self._preset_position: int | None = None
        self._setlist_is_factory = False
        self._mode_cycle: list[int] = []
        # A fast drag write is permitted only for the exact editor context that
        # was established by the most recent verified block_details read.
        self._live_editor_context: dict[str, Any] | None = None

    @property
    def connected(self) -> bool:
        return self._qc is not None

    def close(self) -> None:
        qc, self._qc = self._qc, None
        self._connected_at = None
        self._preset_cache.clear()
        self._preset_folder_cache = None
        self._setlist_key = None
        self._preset_position = None
        self._setlist_is_factory = False
        self._mode_cycle = []
        self._live_editor_context = None
        if qc is not None:
            qc.close()

    def reconnect(self) -> dict[str, Any]:
        self.close()
        pyquadcortex = _protocol_api()

        from .native_transport import connect_native, native_broker_enabled

        # File READ is not required for a usable control session. On a populated
        # QC it can enqueue hundreds of folder listings ahead of the active
        # RecallPreset response, adding roughly ten seconds to startup. Directory
        # methods already issue their own File READ, so defer that transfer until
        # the user actually opens the preset browser. Keep the rest of the
        # hardware-confirmed pyquadcortex hello sequence intact.
        subscribe_types = pyquadcortex.QuadCortex._SUBSCRIBE_TYPES
        if "File" in subscribe_types:
            pyquadcortex.QuadCortex._SUBSCRIBE_TYPES = tuple(
                message_type for message_type in subscribe_types if message_type != "File"
            )
        # Installed Windows builds ship a native HID owner. pyquadcortex remains
        # the complete domain/protobuf layer, while USB enumeration, framing,
        # reads, keepalive, and reconnection readiness happen off the Python/UI
        # threads. Source/dev environments without the broker retain the direct
        # transport as a compatibility fallback.
        self._qc = connect_native() if native_broker_enabled() else pyquadcortex.connect()
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
            "demo": False,
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

    def tempo_clock_state(self) -> dict[str, Any]:
        """Read the broker's cached metronome edge; never performs a preset scan."""
        qc = self._require_session()
        clock_reader = getattr(getattr(qc, "_t", None), "tempo_clock", None)
        if clock_reader is None:
            return {"available": False}
        clock = clock_reader()
        return {"available": clock is not None, **(clock or {})}

    def state_events(self, after_sequence: int = 0, limit: int = 256) -> dict[str, Any]:
        """Pass through Rust-normalized frames without Python protobuf decoding."""
        if isinstance(after_sequence, bool) or not isinstance(after_sequence, int) or after_sequence < 0:
            raise ValueError("afterSequence must be a non-negative integer.")
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 4096:
            raise ValueError("limit must be an integer from 1 through 4096.")
        qc = self._require_session()
        reader = getattr(getattr(qc, "_t", None), "state_events", None)
        if not callable(reader):
            raise RuntimeError("device.stateEvents requires the native Rust device broker in compatibility mode.")
        return {"native": True, "frames": reader(after_sequence, limit)}

    def _require_session(self) -> Any:
        if self._qc is None:
            raise RuntimeError("No Quad Cortex session. Connect before using device controls.")
        return self._qc

    def _native_gateway(self, method: str, params: dict[str, Any] | None = None) -> Any:
        """Use the Rust compatibility broker for surfaces not exposed by pyquadcortex."""
        transport = getattr(self._require_session(), "_t", None)
        request = getattr(transport, "gateway_request", None)
        if not callable(request):
            raise RuntimeError(f"{method} requires the native Rust device broker in compatibility mode.")
        return request(method, params or {})

    def get_global_eq(self): return self._native_gateway("device.globalEq")
    def set_global_eq_bypassed(self, bypassed): return self._native_gateway("device.setGlobalEqBypassed", {"bypassed": bypassed})
    def set_global_eq_band(self, band, gain, frequency, q, filter_type, enabled):
        return self._native_gateway("device.setGlobalEqBand", {"band": band, "gain": gain, "frequency": frequency, "q": q, "filterType": filter_type, "enabled": enabled})
    def set_global_eq_output(self, level, out12, out34):
        return self._native_gateway("device.setGlobalEqOutput", {"level": level, "out12": out12, "out34": out34})
    def get_mode_cycle(self): return self._native_gateway("device.modeCycle")
    def set_mode_cycle(self, slots): return self._native_gateway("device.setModeCycle", {"slots": slots})
    def get_global_tempo_settings(self): return self._native_gateway("device.globalTempoSettings")
    def set_tempo_metronome(self, led_enabled, volume_db, running, pan, time_signature, subdivision, sound, routing, beats):
        return self._native_gateway("device.setTempoMetronome", {"ledEnabled": led_enabled, "volumeDb": volume_db, "running": running, "pan": pan, "timeSignature": time_signature, "subdivision": subdivision, "sound": sound, "routing": routing, "beats": beats})
    def set_tempo_mode(self, mode): return self._native_gateway("device.setTempoMode", {"mode": mode})
    def get_looper_status(self): return self._native_gateway("device.looperStatus")
    def control_looper(self, command, value): return self._native_gateway("device.controlLooper", {"command": command, "value": value})
    def list_recents(self): return self._native_gateway("device.recents")
    def list_favorites(self): return self._native_gateway("device.favorites")
    def set_favorite(self, name, folder_key, folder_name, is_factory, favorite):
        return self._native_gateway("device.setFavorite", {"name": name, "folderKey": folder_key, "folderName": folder_name, "isFactory": is_factory, "favorite": favorite})
    def list_pinned_models(self): return self._native_gateway("device.pinnedModels")
    def set_model_pinned(self, model_id, pinned): return self._native_gateway("device.setModelPinned", {"modelId": model_id, "pinned": pinned})
    def list_captures(self): return self._native_gateway("device.captures")
    def load_capture(self, row, column, key, name, model_id, expected_model_id, expected_preset_name=""):
        return self._native_gateway("device.loadCapture", {"row": row, "column": column, "key": key, "name": name, "modelId": model_id, "expectedModelId": expected_model_id, "expectedPresetName": expected_preset_name})
    def list_irs(self, folder): return self._native_gateway("device.irs", {"folder": folder})
    def load_ir(self, row, column, key, name, slot, model_id, expected_model_id, expected_preset_name=""):
        return self._native_gateway("device.loadIr", {"row": row, "column": column, "key": key, "name": name, "slot": slot, "modelId": model_id, "expectedModelId": expected_model_id, "expectedPresetName": expected_preset_name})
    def create_setlist(self, name): return self._native_gateway("device.createSetlist", {"name": name})
    def delete_setlist(self, name): return self._native_gateway("device.deleteSetlist", {"name": name})
    def duplicate_setlist(self, source_setlist_key, destination_name, limit, expected_preset_name, expected_position):
        return self._native_gateway("device.duplicateSetlist", {"sourceSetlistKey": source_setlist_key, "destinationName": destination_name, "limit": limit, "expectedPresetName": expected_preset_name, "expectedPosition": expected_position})
    def delete_preset(self, setlist_key, name): return self._native_gateway("device.deletePreset", {"setlistKey": setlist_key, "name": name})
    def move_preset(self, setlist_key, name, position): return self._native_gateway("device.movePreset", {"setlistKey": setlist_key, "name": name, "position": position})

    def _ensure_catalog(self) -> Any:
        """Fetch the compatibility catalog; native UI metadata is owned by Rust."""
        qc = self._require_session()
        if getattr(qc, "_catalog", None) is None:
            payload = qc._fetch_model_repo()
            qc._catalog = _parse_model_repo(payload)
        return qc._catalog

    def _parameter_display_metadata(self, model_id: int, parameter_index: int, spec: Any, options: list[str]) -> dict[str, Any]:
        return {
            "minimum": float(spec.minimum), "maximum": float(spec.maximum),
            "valueScale": "options" if options else "unknown", "scaleExponent": None,
            "scalePoints": [],
            "displayPrecision": None, "scaleKnown": bool(options), "units": spec.units,
            "minimumLabel": None, "midpointLabel": None, "maximumLabel": None,
        }

    def _assert_expected_preset(self, expected_name: str) -> Any:
        qc = self._require_session()
        preset = qc.read_current_preset()
        actual_name = preset.name or ""
        unnamed_placeholder = expected_name.casefold() in {"current preset", "empty preset", "unsaved"}
        if expected_name and actual_name != expected_name and not (not actual_name and unnamed_placeholder):
            raise RuntimeError(
                f"Preset changed on the Quad Cortex: expected {expected_name!r}, "
                f"but {preset.name or 'an unnamed preset'!r} is active. Refresh and retry."
            )
        return preset

    def _read_position_state(self, timeout: float = 10.0) -> Any:
        pa = _production_automation_proto()

        return self._require_session()._read_state(
            pa.SetlistPositionMessage,
            lambda message: message.HasField("position") and bool(message.folder_key),
            timeout,
        )

    def _remember_position(self, state: Any) -> None:
        self._setlist_key = state.folder_key
        self._preset_position = int(state.position)
        self._setlist_is_factory = bool(state.is_factory)

    def _current_position(self, refresh: bool = False) -> tuple[str, int, bool]:
        if refresh or self._setlist_key is None or self._preset_position is None:
            self._remember_position(self._read_position_state())
        return self._setlist_key, self._preset_position, self._setlist_is_factory

    def list_presets(self, refresh: bool = False, setlist_key: str | None = None) -> dict[str, Any]:
        pyquadcortex = _protocol_api()

        qc = self._require_session()
        active_setlist_key, current_position, _ = self._current_position(refresh=True)
        target_setlist_key = setlist_key or active_setlist_key
        if refresh or target_setlist_key not in self._preset_cache:
            entries = qc.list_presets(target_setlist_key, timeout=25.0, include_empty=True)
            by_position = {
                int(entry.index): entry
                for entry in entries
                if entry.HasField("index")
            }
            self._preset_cache[target_setlist_key] = [
                {
                    "position": position,
                    "location": pyquadcortex.position_to_slot(position),
                    "name": entry.name if entry is not None and entry.HasField("name") and entry.name else "Unsaved",
                    "instrument": int(entry.instrument) if entry is not None and entry.HasField("instrument") else 0,
                }
                for position in range(256)
                for entry in [by_position.get(position)]
            ]
        return {
            "setlistKey": target_setlist_key,
            "setlistName": target_setlist_key.rstrip("/").rsplit("/", 1)[-1],
            "currentPosition": current_position if target_setlist_key.rstrip("/") == active_setlist_key.rstrip("/") else -1,
            "presets": self._preset_cache[target_setlist_key],
            # Folder discovery is deliberately lazy. An empty list means it has
            # not been requested yet; never invent device library entries.
            "folders": list(self._preset_folder_cache or []),
        }

    def list_preset_folders(self, refresh: bool = False) -> dict[str, Any]:
        if refresh or self._preset_folder_cache is None:
            user_root = "/media/p4/Presets"
            factory_key = "/opt/neuraldsp/Factory Library"
            folders = []
            for folder in self._require_session().list_folders(seconds=20.0):
                key = str(folder.key).rstrip("/")
                is_user_setlist = key.rsplit("/", 1)[0] == user_root
                is_factory = key == factory_key
                if not is_user_setlist and not is_factory:
                    continue
                folders.append({
                    "key": str(folder.key),
                    "name": folder.name or key.rsplit("/", 1)[-1],
                    "isFactory": bool(folder.is_factory) or is_factory,
                })
            self._preset_folder_cache = sorted(folders, key=lambda item: (item["isFactory"], item["name"].casefold()))
        return {"folders": self._preset_folder_cache}

    def list_preset_slots(self) -> dict[str, Any]:
        pyquadcortex = _protocol_api()

        qc = self._require_session()
        setlist_key, current_position, is_factory = self._current_position(refresh=True)
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

    def create_device_backup(self, name: str, timeout: float = 60.0) -> dict[str, Any]:
        """Collect the QC's native chunked backup JSON without opening its payload."""
        pa = _production_automation_proto()

        clean_name = "".join(character for character in str(name) if character.isprintable()).strip()
        if not clean_name:
            raise ValueError("Backup name cannot be empty.")
        clean_name = clean_name[:80]

        qc = self._require_session()
        transport = qc._t
        messages: list[Any] = []
        collector = (pa.LocalBackupMessage, None, messages)
        with transport._lock:
            transport._collectors.append(collector)
        try:
            transport.send(pa.LocalBackupMessage(action=pa.MessageAction.CREATE))
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                transport._check_lost()
                if messages and bool(messages[-1].is_last_chunk):
                    break
                time.sleep(0.1)
        finally:
            with transport._lock:
                if collector in transport._collectors:
                    transport._collectors.remove(collector)

        if not messages or not bool(messages[-1].is_last_chunk):
            raise TimeoutError("The Quad Cortex did not finish the native backup within 60 seconds.")
        if sum(bool(message.is_last_chunk) for message in messages) != 1:
            raise RuntimeError("The Quad Cortex returned an invalid backup chunk sequence.")
        backup_json = "".join(message.backup_json for message in messages if message.backup_json)
        if not backup_json or len(backup_json.encode("utf-8")) > 32 * 1024 * 1024:
            raise RuntimeError("The Quad Cortex returned an empty or oversized backup document.")
        try:
            document = json.loads(backup_json)
        except json.JSONDecodeError as error:
            raise RuntimeError(f"The Quad Cortex returned malformed backup JSON: {error.msg}.") from error
        if not isinstance(document, dict) or document.get("type") != "backup" or document.get("creator") != "quad":
            raise RuntimeError("The Quad Cortex returned an unsupported backup document.")
        payload = document.get("payload")
        payload_hash = document.get("payload_hash")
        if not isinstance(payload, str) or not isinstance(payload_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", payload_hash):
            raise RuntimeError("The Quad Cortex backup is missing its native payload or integrity identifier.")
        try:
            base64.b64decode(payload, validate=True)
        except (ValueError, TypeError) as error:
            raise RuntimeError("The Quad Cortex backup payload is not valid Base64.") from error
        document["name"] = clean_name
        return document

    def list_models(self) -> dict[str, Any]:
        qc = self._require_session()
        catalog = self._ensure_catalog()
        audit = _catalog_audit(catalog)
        models = [
            {
                "id": int(model.id),
                "name": model.name,
                "category": _device_type_name(model.category),
                "basedOn": model.based_on,
            }
            for model in catalog
            if not model.hidden and not model.internal and not model.category_hidden and not model.superseded
        ]
        models.sort(key=lambda model: (model["category"].casefold(), model["name"].casefold(), model["id"]))
        return {"models": models, "audit": audit}

    def identity(self) -> dict[str, Any]:
        """Read identity through pyquadcortex and use the native gateway shape."""
        message = self._require_session().version()
        if not message.HasField("device_serial_number"):
            raise RuntimeError("The Quad Cortex identity reply did not include a serial number.")
        return {
            "serial": message.device_serial_number,
            "appFwVersion": message.app_fw_version if message.HasField("app_fw_version") else None,
            "customName": message.custom_name if message.HasField("custom_name") else None,
            "deviceType": int(message.device_type) if message.HasField("device_type") else None,
        }

    def set_device_name(self, name: str) -> dict[str, Any]:
        if not isinstance(name, str) or not name:
            raise ValueError("name must be a non-empty string")
        if any(character.isprintable() is False for character in name) or len(name) > 64:
            raise ValueError("Device name must be at most 64 visible characters")
        qc = self._require_session()
        _pyquadcortex_method(qc, "set_device_name")(name)
        return {"detail": f"Device name change to {name} sent"}

    def undo(self) -> dict[str, Any]:
        qc = self._require_session()
        _pyquadcortex_method(qc, "undo")()
        return {"detail": "Device undo sent"}

    def redo(self) -> dict[str, Any]:
        qc = self._require_session()
        _pyquadcortex_method(qc, "redo")()
        return {"detail": "Device redo sent"}

    def inhibited_modules(self) -> dict[str, Any]:
        qc = self._require_session()
        message = _pyquadcortex_method(qc, "inhibited_modules")()
        if not message.HasField("global_gate") or not message.HasField("global_eq"):
            raise RuntimeError("The Quad Cortex inhibited-modules reply was incomplete.")
        return {"globalGate": bool(message.global_gate), "globalEq": bool(message.global_eq)}

    def tuner_settings(self) -> dict[str, Any]:
        """Read tuner preferences without engaging or changing the tuner."""
        message = _pyquadcortex_method(self._require_session(), "tuner")()
        if not all(message.HasField(field) for field in ("input_port_id", "frequency", "mute")):
            raise RuntimeError("The Quad Cortex tuner reply was incomplete.")
        offset = float(message.frequency)
        return {
            "inputPortId": int(message.input_port_id),
            "referenceOffsetHz": offset,
            "referenceHz": 440.0 + offset,
            "muted": bool(message.mute),
        }

    @staticmethod
    def _confirm_tuner_activation(confirmed: bool) -> None:
        if confirmed is not True:
            raise ValueError(
                "A tuner write invisibly engages the tuner and may silence every output; "
                "confirmTunerActivation must be true."
            )

    def set_tuner_input(self, input_port_id: int, confirm_tuner_activation: bool) -> dict[str, Any]:
        self._confirm_tuner_activation(confirm_tuner_activation)
        if input_port_id not in (1, 2, 3, 4, 5, 8, 9):
            raise ValueError("inputPortId must be 1, 2, 3, 4, 5, 8, or 9")
        _pyquadcortex_method(self._require_session(), "set_tuner_input")(input_port_id)
        return {"detail": "Tuner input updated; the tuner is now invisibly engaged"}

    def set_tuner_mute(self, muted: bool, confirm_tuner_activation: bool) -> dict[str, Any]:
        self._confirm_tuner_activation(confirm_tuner_activation)
        if not isinstance(muted, bool):
            raise ValueError("muted must be a boolean")
        _pyquadcortex_method(self._require_session(), "set_tuner_mute")(muted)
        return {"detail": "Tuner mute preference updated; the tuner is now invisibly engaged"}

    def restore_tuner_audio(self, confirm_preference_reset: bool) -> dict[str, Any]:
        if confirm_preference_reset is not True:
            raise ValueError(
                "Restoring audio clears the persistent mute-while-tuning preference; "
                "confirmPreferenceReset must be true."
            )
        acted = bool(_pyquadcortex_method(self._require_session(), "restore_audio")())
        return {"detail": "Tuner mute preference cleared to restore audio", "acted": acted}

    def set_tuner_reference(
        self, reference_offset_hz: float, confirm_tuner_activation: bool
    ) -> dict[str, Any]:
        self._confirm_tuner_activation(confirm_tuner_activation)
        if (
            isinstance(reference_offset_hz, bool)
            or not isinstance(reference_offset_hz, (int, float))
            or not math.isfinite(reference_offset_hz)
        ):
            raise ValueError("referenceOffsetHz must be a finite Hz offset from 440")
        pyquadcortex = _protocol_api()
        _pyquadcortex_method(self._require_session(), "set_tuner_reference")(
            pyquadcortex.Hertz(float(reference_offset_hz))
        )
        return {"detail": "Tuner reference updated; the tuner is now invisibly engaged"}

    def general_settings(self) -> dict[str, Any]:
        """Compatibility projection of the native Rust GeneralSettings payload."""
        message = _pyquadcortex_method(self._require_session(), "settings")()
        scalar_fields = {
            "screenBrightness": "screen_brightness", "ledBrightness": "led_brightness",
            "dimmedLedBrightness": "dimmed_led_brightness",
            "lockScreenAndVolumeKnob": "lock_screen_and_volume_knob",
            "midiOverUsb": "midi_over_usb", "midiChannel": "midi_channel",
            "ignoreDuplicatePc": "ignore_duplicate_pc", "availableDiskSpace": "available_disk_space",
            "totalDiskSpace": "total_disk_space", "internalMidiClockEnabled": "internal_midi_clock_enabled",
            "stompModeAutoAssign": "stomp_mode_auto_assign",
            "swapTempoTunerAccess": "swap_tempo_tuner_access",
            "disableInternetConnectionCheck": "disable_internet_connection_check",
            "dynamicDelayCompensation": "enable_dynamic_delay_compensation",
            "presetDimmed": "enable_preset_dimmed", "sceneDimmed": "enable_scene_dimmed",
            "stompDimmed": "enable_stomp_dimmed", "midiClockIn": "midi_clock_in_enabled",
            "gigViewStompAccess": "gig_view_stomp_access_enabled",
            "holdTimingIndex": "hold_timing",
        }
        result = {public: getattr(message, wire) for public, wire in scalar_fields.items()
                  if message.HasField(wire)}
        if "holdTimingIndex" in result and 0 <= result["holdTimingIndex"] <= 5:
            result["holdTimingMs"] = 500 + 100 * result["holdTimingIndex"]
        if message.HasField("scene_block_bypass"):
            behavior = {0: "alwaysOverwrite", 1: "nonstompOverwrite", 2: "neverOverwrite"}.get(int(message.scene_block_bypass))
            if behavior is not None:
                result["sceneBypassBehavior"] = behavior
        if message.HasField("midi_clock_out"):
            clock = {0: "off", 1: "midiDinOnly", 2: "usbMidiOnly", 3: "bothUsbAndDinMidi"}.get(int(message.midi_clock_out))
            if clock is not None:
                result["midiClockOut"] = clock
        for public, wire in (("globalBypassCab", "global_bypass_cab"), ("globalBypassIr", "global_bypass_ir")):
            if message.HasField(wire):
                rows = getattr(message, wire)
                result[public] = {f"row{index}": bool(getattr(rows, f"row{index}")) for index in range(1, 5)}
        if message.HasField("master_volume_assignment"):
            assignment = message.master_volume_assignment
            result["masterVolumeAssignment"] = {name: bool(getattr(assignment, name)) for name in ("out12", "out34", "send12", "headphones")}
        return result

    def io_settings(self) -> dict[str, Any]:
        """Compatibility projection of the native Rust IoSettings payload."""
        message = _pyquadcortex_method(self._require_session(), "io_settings")()

        def optional_fields(item: Any, fields: tuple[tuple[str, str], ...]) -> dict[str, Any]:
            return {
                public: getattr(item, wire)
                for public, wire in fields
                if item.HasField(wire)
            }

        inputs = []
        for port in message.settings.in_port:
            projected = {"inputPortId": int(port.input_port_id), **optional_fields(port, (
                ("level", "level"), ("impedance", "input_zmode"),
                ("inputType", "input_type"), ("groundLift", "ground_lift"),
                ("plugged", "plugged"),
            ))}
            if "level" in projected:
                projected["levelDb"] = float(projected["level"]) * 72.0 - 12.0
            inputs.append(projected)
        outputs = [
            {"outputPortId": int(port.output_port_id), **optional_fields(port, (
                ("level", "level"), ("groundLift", "ground_lift"),
                ("muted", "mute"), ("plugged", "plugged"),
            ))}
            for port in message.settings.out_port
        ]
        result: dict[str, Any] = {"inputs": inputs, "outputs": outputs, "expressions": [
            {"expressionPortId": int(port.exp_port_id), **optional_fields(port, (
                ("plugged", "plugged"), ("level", "level"),
                ("calibrating", "calibrating"),
            ))}
            for port in message.settings.exp_port
        ]}
        if message.settings.HasField("hp_port"):
            port = message.settings.hp_port
            result["headphones"] = {**optional_fields(port, (
                ("level", "level"), ("plugged", "plugged"),
            )), "feeds": [
                {"level": float(feed.level), "outputPortId": int(feed.output_port_id)}
                for feed in port.hp_feed
            ]}
        if message.settings.HasField("usb_port"):
            result["usb"] = optional_fields(message.settings.usb_port, (
                ("level", "level"), ("headphonesSource", "hp_select"),
                ("plugged", "plugged"), ("dryWet", "dry_wet"),
            ))
        if message.settings.HasField("midi_port"):
            result["midi"] = optional_fields(message.settings.midi_port, (("thru", "midi_thru"),))
        if message.HasField("xlr1_2_linked"):
            result["xlr12Linked"] = bool(message.xlr1_2_linked)
        if message.HasField("out3_4_linked"):
            result["out34Linked"] = bool(message.out3_4_linked)
        return result

    def set_input_port(self, input_port_id: int, level_db: float | None,
                       impedance: float | None, input_type: float | None,
                       ground_lift: float | None) -> dict[str, Any]:
        if isinstance(input_port_id, bool) or not isinstance(input_port_id, int) or not 1 <= input_port_id <= 14:
            raise ValueError("inputPortId must be an integer from 1 through 14")
        level_db = _optional_finite_range(level_db, "levelDb", -12.0, 60.0)
        impedance = _optional_finite_range(impedance, "impedance", 0.0, 1.0)
        input_type = _optional_finite_range(input_type, "inputType", 0.0, 1.0)
        ground_lift = _optional_finite_range(ground_lift, "groundLift", 0.0, 1.0)
        protocol = _protocol_api()
        level = None if level_db is None else protocol.Db(float(level_db))
        _pyquadcortex_method(self._require_session(), "set_input_port")(
            input_port_id, level=level, impedance=impedance,
            input_type=input_type, ground_lift=ground_lift)
        return {"detail": f"Input port {input_port_id} settings sent to the Quad Cortex"}

    def set_output_port(self, output_port_id: int, level: float | None,
                        ground_lift: float | None, mute: bool | None) -> dict[str, Any]:
        if isinstance(output_port_id, bool) or not isinstance(output_port_id, int) or not 1 <= output_port_id <= 22:
            raise ValueError("outputPortId must be an integer from 1 through 22")
        level = _optional_finite_range(level, "level", 0.0, 1.0)
        ground_lift = _optional_finite_range(ground_lift, "groundLift", 0.0, 1.0)
        if mute is not None and not isinstance(mute, bool):
            raise ValueError("mute must be a boolean or null")
        encoded = None if level is None else _protocol_api().Encoded(level)
        _pyquadcortex_method(self._require_session(), "set_output_port")(
            output_port_id, level=encoded, ground_lift=ground_lift, mute=mute)
        return {"detail": f"Output port {output_port_id} settings sent to the Quad Cortex"}

    def set_usb_port(self, level: float | None, headphones_source: float | None,
                     dry_wet: float | None) -> dict[str, Any]:
        level = _optional_finite_range(level, "level", 0.0, 1.0)
        headphones_source = _optional_finite_range(headphones_source, "headphonesSource", 0.0, 1.0)
        dry_wet = _optional_finite_range(dry_wet, "dryWet", 0.0, 1.0)
        encoded = None if level is None else _protocol_api().Encoded(level)
        _pyquadcortex_method(self._require_session(), "set_usb_port")(
            level=encoded, hp_select=headphones_source, dry_wet=dry_wet)
        return {"detail": "USB port settings sent to the Quad Cortex"}

    def set_midi_thru(self, enabled: bool) -> dict[str, Any]:
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        _pyquadcortex_method(self._require_session(), "set_midi_thru")(enabled)
        return {"detail": "MIDI Thru setting sent to the Quad Cortex"}

    def set_output_pairing(self, xlr12_linked: bool | None,
                           out34_linked: bool | None) -> dict[str, Any]:
        if any(value is not None and not isinstance(value, bool)
               for value in (xlr12_linked, out34_linked)):
            raise ValueError("output pairing values must be booleans or null")
        if xlr12_linked is None and out34_linked is None:
            raise ValueError("at least one output pairing value must be supplied")
        _pyquadcortex_method(self._require_session(), "set_output_pairing")(
            xlr1_2=xlr12_linked, out3_4=out34_linked)
        return {"detail": "Output pairing settings sent to the Quad Cortex"}

    def set_general_integer(self, setting: str, value: int) -> dict[str, Any]:
        fields = {"screenBrightness": ("screen_brightness", 0, 100), "ledBrightness": ("led_brightness", 0, 100),
                  "dimmedLedBrightness": ("dimmed_led_brightness", 0, 100), "holdTiming": ("hold_timing", 0, 5),
                  "midiChannel": ("midi_channel", 0, 16)}
        if setting not in fields or isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("Unsupported GeneralSettings integer")
        wire, minimum, maximum = fields[setting]
        if not minimum <= value <= maximum:
            raise ValueError(f"value must be {minimum} through {maximum}")
        _pyquadcortex_method(self._require_session(), "update_settings")(**{wire: value})
        return {"detail": "Global device setting sent to the Quad Cortex"}

    def set_general_toggle(self, setting: str, enabled: bool) -> dict[str, Any]:
        fields = {"midiOverUsb": "midi_over_usb",
                  "ignoreDuplicatePc": "ignore_duplicate_pc", "stompModeAutoAssign": "stomp_mode_auto_assign",
                  "swapTempoTunerAccess": "swap_tempo_tuner_access", "disableInternetConnectionCheck": "disable_internet_connection_check",
                  "dynamicDelayCompensation": "enable_dynamic_delay_compensation", "presetDimmed": "enable_preset_dimmed",
                  "midiClockIn": "midi_clock_in_enabled", "gigViewStompAccess": "gig_view_stomp_access_enabled"}
        if setting not in fields or not isinstance(enabled, bool):
            raise ValueError("Unsupported GeneralSettings toggle")
        _pyquadcortex_method(self._require_session(), "update_settings")(**{fields[setting]: enabled})
        return {"detail": "Global device setting sent to the Quad Cortex"}

    def set_scene_bypass_behavior(self, behavior: str) -> dict[str, Any]:
        values = {"alwaysOverwrite": 0, "nonstompOverwrite": 1, "neverOverwrite": 2}
        if behavior not in values:
            raise ValueError("Invalid scene bypass behavior")
        _pyquadcortex_method(self._require_session(), "update_settings")(scene_block_bypass=values[behavior])
        return {"detail": "Global device setting sent to the Quad Cortex"}

    def set_master_volume_assignment(self, out12: bool, out34: bool, send12: bool, headphones: bool) -> dict[str, Any]:
        if not all(isinstance(value, bool) for value in (out12, out34, send12, headphones)):
            raise ValueError("Master Volume assignments must be booleans")
        _pyquadcortex_method(self._require_session(), "set_master_volume_assignment")(
            out12=out12, out34=out34, send12=send12, headphones=headphones)
        return {"detail": "Master Volume assignments sent to the Quad Cortex"}

    def set_global_bypass(self, cab: list[bool], ir: list[bool]) -> dict[str, Any]:
        if any(not isinstance(rows, list) or len(rows) != 4 or not all(isinstance(value, bool) for value in rows)
               for rows in (cab, ir)):
            raise ValueError("cab and ir must each contain four booleans")
        _pyquadcortex_method(self._require_session(), "set_global_bypass")(cab=cab, ir=ir)
        return {"detail": "Global bypass rows sent to the Quad Cortex"}

    def preset_screenshot(
        self,
        folder_name: str,
        position: int,
        is_factory: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(folder_name, str) or not folder_name:
            raise ValueError("folderName must be a non-empty string")
        if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position <= 255:
            raise ValueError("position must be an integer from 0 through 255")
        if not isinstance(is_factory, bool):
            raise ValueError("isFactory must be a boolean")
        qc = self._require_session()
        image = _pyquadcortex_method(qc, "preset_screenshot")(
            folder_name, position, is_factory=is_factory
        )
        return _png_response(image)

    def capture_screen(self) -> dict[str, Any]:
        qc = self._require_session()
        return _png_response(_pyquadcortex_method(qc, "capture_screen")())

    def tap_screen(self, x: float, y: float) -> dict[str, Any]:
        for name, value, upper in (("x", x, 800.0), ("y", y, 480.0)):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value < upper
            ):
                raise ValueError(f"{name} must satisfy 0 <= {name} < {upper}")
        qc = self._require_session()
        _pyquadcortex_method(qc, "tap_screen")(x, y)
        return {"detail": f"Tapped the Quad Cortex screen at ({x}, {y})"}

    def save_preset_as(
        self,
        setlist_key: str,
        position: int,
        name: str,
        expected_preset_name: str,
        expected_position: int,
        confirm_overwrite: bool,
    ) -> dict[str, Any]:
        pyquadcortex = _protocol_api()

        if not isinstance(name, str) or not name.strip():
            raise ValueError("Preset name is required.")
        name = name.strip()
        if len(name) > 80:
            raise ValueError("Preset name must be 80 characters or fewer.")
        if not isinstance(confirm_overwrite, bool):
            raise ValueError("Overwrite confirmation must be true or false.")
        qc = self._require_session()
        current_key, current_position, is_factory = self._current_position(refresh=True)
        current_preset = self._assert_expected_preset(expected_preset_name)
        if current_key != setlist_key or current_position != expected_position:
            raise RuntimeError("The active preset or setlist changed. Refresh and retry.")
        if is_factory:
            raise RuntimeError("Factory Library is read-only. Recall a user setlist before saving.")
        if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position < 256:
            raise ValueError("Preset position must be an integer from 0 through 255.")

        cached_entries = self._preset_cache.get(setlist_key)
        destination = next(
            (entry for entry in cached_entries or [] if entry["position"] == position),
            None,
        )
        saving_current_unnamed_slot = position == current_position and not (current_preset.name or "")
        if not confirm_overwrite and not saving_current_unnamed_slot:
            if cached_entries is None:
                raise RuntimeError(
                    "That destination has not been synchronized. Refresh its setlist before saving without overwrite confirmation."
                )
            if destination is not None:
                raise RuntimeError(
                    f"Slot {destination['location']} contains {destination['name']!r}; explicit overwrite confirmation is required."
                )
        current_entry = next(
            (entry for entry in cached_entries or [] if entry["position"] == current_position),
            None,
        )
        instrument = current_entry["instrument"] if current_entry else 0
        active_scene = int(qc.active_scene())
        native_save = _native_transport_method(qc, "save_preset")
        if native_save is not None:
            native_save(setlist_key, position, name, instrument)
        else:
            qc.save_current_preset(
                setlist_key,
                position,
                name,
                instrument=instrument,
                default_scene=active_scene,
                confirm=False,
            )
        _wait_for_dirty(qc, False, timeout=5.0)
        saved_key, saved_position, saved_is_factory = self._current_position(refresh=True)
        if saved_is_factory or saved_key != setlist_key or saved_position != position:
            raise RuntimeError("The active preset position changed while the save was being verified.")
        saved_preset = qc.read_current_preset(timeout=15.0)
        stored_name = saved_preset.name or ""
        if not stored_name:
            raise RuntimeError("The device did not expose a saved preset name during live readback.")
        self._setlist_key = setlist_key
        self._preset_position = position
        if cached_entries is not None:
            cached_entries[:] = [entry for entry in cached_entries if entry["position"] != position]
            cached_entries.append({
                "position": position,
                "location": pyquadcortex.position_to_slot(position),
                "name": stored_name,
                "instrument": instrument,
            })
            cached_entries.sort(key=lambda entry: entry["position"])
        snapshot = self.snapshot()
        if snapshot["presetName"] != stored_name or snapshot["dirty"]:
            raise RuntimeError("The preset saved, but final live-state verification failed.")
        return {
            "detail": f"Saved and verified {pyquadcortex.position_to_slot(position)} · {stored_name}",
            "savedName": stored_name,
            "snapshot": snapshot,
        }

    def rename_current_preset(
        self,
        name: str,
        expected_preset_name: str,
        expected_position: int,
        confirm_rename: bool,
    ) -> dict[str, Any]:
        if confirm_rename is not True:
            raise RuntimeError("Renaming a stored preset requires explicit confirmation.")
        clean_name = name.strip() if isinstance(name, str) else ""
        if not clean_name:
            raise ValueError("Preset name is required.")
        if clean_name == expected_preset_name:
            raise ValueError("The new preset name is identical to the current name.")
        setlist_key, position, is_factory = self._current_position(refresh=True)
        if is_factory:
            raise RuntimeError("Factory Library is read-only. Save the preset to a user setlist before renaming it.")
        if position != expected_position:
            raise RuntimeError("The active preset position changed. Refresh and retry.")
        result = self.save_preset_as(
            setlist_key,
            position,
            clean_name,
            expected_preset_name,
            expected_position,
            True,
        )
        result["detail"] = f"Renamed and verified {result['snapshot']['presetLocation']} · {result['savedName']}"
        return result

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
    ) -> dict[str, Any]:
        """Copy one stored preset over the currently loaded user preset slot."""
        pyquadcortex = _protocol_api()

        if not isinstance(source_setlist_key, str) or not source_setlist_key.strip():
            raise ValueError("Source setlist is required.")
        if not isinstance(destination_setlist_key, str) or not destination_setlist_key.strip():
            raise ValueError("Destination setlist is required.")
        for label, position in (("Source", source_position), ("Destination", destination_position)):
            if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position < 256:
                raise ValueError(f"{label} preset position must be an integer from 0 through 255.")
        if confirm_overwrite is not True:
            raise RuntimeError("Pasting a preset requires explicit overwrite confirmation.")
        if source_setlist_key.rstrip("/") == destination_setlist_key.rstrip("/") and source_position == destination_position:
            raise ValueError("The source and destination preset slots are identical.")

        qc = self._require_session()
        current_key, current_position, is_factory = self._current_position(refresh=True)
        self._assert_expected_preset(expected_preset_name)
        if current_key.rstrip("/") != destination_setlist_key.rstrip("/") or current_position != expected_position or current_position != destination_position:
            raise RuntimeError("The destination preset or setlist changed. Refresh and retry.")
        if is_factory:
            raise RuntimeError("Factory Library is read-only. Paste into a user setlist instead.")
        if qc.preset_dirty():
            raise RuntimeError("The destination has unsaved changes. Save or discard them before pasting a preset.")

        source_listing = self.list_presets(refresh=True, setlist_key=source_setlist_key)["presets"]
        source = next((entry for entry in source_listing if entry["position"] == source_position), None)
        if source is None or source["name"] == "Unsaved":
            raise RuntimeError("The copied source preset no longer exists.")
        if source_name and source["name"] != source_name:
            raise RuntimeError(
                f"The copied source changed from {source_name!r} to {source['name']!r}. Copy it again before pasting."
            )

        native_save = _native_transport_method(qc, "save_preset")
        if native_save is not None:
            qc.read_preset(source_setlist_key, source_position, timeout=15.0)
            native_save(destination_setlist_key, destination_position, source["name"], source["instrument"])
            stored_name = source["name"]
        else:
            stored_name = qc.copy_preset(
                source_setlist_key,
                source_position,
                destination_setlist_key,
                to_position=destination_position,
                name=source["name"],
                instrument=source["instrument"],
            )
        _wait_for_dirty(qc, False, timeout=5.0)
        saved_key, saved_position, saved_is_factory = self._current_position(refresh=True)
        if saved_is_factory or saved_key.rstrip("/") != destination_setlist_key.rstrip("/") or saved_position != destination_position:
            raise RuntimeError("The preset copy completed, but the destination position could not be verified.")

        self._setlist_key = destination_setlist_key
        self._preset_position = destination_position
        destination_cache = self._preset_cache.get(destination_setlist_key)
        if destination_cache is not None:
            for entry in destination_cache:
                if entry["position"] == destination_position:
                    entry.update(name=stored_name, instrument=source["instrument"])
                    break
        snapshot = self.snapshot()
        if snapshot["presetName"] != stored_name or snapshot["dirty"]:
            raise RuntimeError("The preset copied, but final live-state verification failed.")
        return {
            "detail": (
                f"Copied {source['location']} · {source['name']} to "
                f"{pyquadcortex.position_to_slot(destination_position)} and verified"
            ),
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
        pyquadcortex = _protocol_api()

        if isinstance(position, bool) or not isinstance(position, int) or not 0 <= position < 256:
            raise ValueError("Preset position must be an integer from 0 through 255.")
        qc = self._require_session()
        current_key, current_position, _ = self._current_position(refresh=True)
        self._assert_expected_preset(expected_preset_name)
        if expected_position is not None and current_position != expected_position:
            raise RuntimeError("The active preset slot changed on the Quad Cortex. Refresh and retry.")
        if current_key != setlist_key:
            raise RuntimeError("The active setlist changed on the Quad Cortex. Refresh and retry.")
        if qc.preset_dirty():
            raise RuntimeError("The current preset has unsaved changes. Save or revert them before recalling another preset.")

        recalled = qc.read_preset(setlist_key, position, timeout=15.0)
        target_name = recalled.name or "Unsaved"
        self._setlist_key = setlist_key
        self._preset_position = position
        snapshot = self.snapshot()
        if snapshot["presetName"] != target_name:
            raise RuntimeError("Preset recall landed, but live preset readback did not match.")
        return {
            "detail": f"Recalled {pyquadcortex.position_to_slot(position)} · {target_name} and verified",
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
        setlist_key, current_position, _ = self._current_position(refresh=True)
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
        setlist_key, current_position, _ = self._current_position(refresh=True)
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

    def select_scene(self, scene: int, expected_preset_name: str = "") -> DeviceActionResult:
        if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
            raise ValueError(f"Scene must be an integer from 0 through {SCENE_COUNT - 1}.")
        qc = self._require_session()
        self._assert_expected_preset(expected_preset_name)
        native_command = getattr(getattr(qc, "_t", None), "select_scene", None)
        if native_command is not None:
            native_command(scene)
        else:
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

    def copy_scene(
        self,
        from_scene: int,
        to_scene: int,
        swap: bool = False,
        expected_preset_name: str = "",
    ) -> DeviceActionResult:
        for label, scene in (("source scene", from_scene), ("destination scene", to_scene)):
            if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
                raise ValueError(f"Expected {label} to be an integer from 0 through {SCENE_COUNT - 1}.")
        if from_scene == to_scene:
            raise ValueError("Source and destination scenes must be different.")
        if not isinstance(swap, bool):
            raise ValueError("Swap must be true or false.")

        qc = self._require_session()
        before = self._assert_expected_preset(expected_preset_name)
        before_labels = list(before.scene_labels)
        before_colors = list(before.scene_colors)
        qc.copy_scene(from_scene, to_scene, swap)

        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            current = qc.read_current_preset()
            labels = list(current.scene_labels)
            colors = list(current.scene_colors)
            copied = labels[to_scene] == before_labels[from_scene] and colors[to_scene] == before_colors[from_scene]
            swapped = not swap or (
                labels[from_scene] == before_labels[to_scene]
                and colors[from_scene] == before_colors[to_scene]
            )
            if copied and swapped:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Scene readback matched, but the device did not mark the preset dirty.")
                verb = "swapped" if swap else "copied"
                return {
                    "detail": f"Scenes {chr(65 + from_scene)} and {chr(65 + to_scene)} {verb} and verified",
                    "snapshot": self.snapshot(),
                }
            time.sleep(0.1)
        raise RuntimeError("The scene-copy command was sent, but readback did not confirm the requested state.")

    def set_scene_label(
        self, scene: int, label: str | None, expected_preset_name: str = ""
    ) -> DeviceActionResult:
        if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
            raise ValueError(f"Scene must be an integer from 0 through {SCENE_COUNT - 1}.")
        if label is not None:
            if not isinstance(label, str):
                raise ValueError("Scene label must be a string or null.")
            if len(label) > 32:
                raise ValueError("Scene label must contain at most 32 characters.")
            if any(ord(character) < 32 or ord(character) == 127 for character in label):
                raise ValueError("Scene label must not contain control characters.")

        qc = self._require_session()
        self._assert_expected_preset(expected_preset_name)
        qc.set_scene_label(scene, label)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            current = qc.read_current_preset()
            actual = list(current.scene_labels)[scene]
            if (label is None and not actual.strip()) or actual == label:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Scene-label readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"Scene {chr(65 + scene)} label updated and verified",
                    "snapshot": self.snapshot(),
                }
            time.sleep(0.1)
        raise RuntimeError("The scene-label command was sent, but readback did not confirm the requested label.")

    def set_scene_color(
        self, scene: int, color: int, expected_preset_name: str = ""
    ) -> DeviceActionResult:
        if isinstance(scene, bool) or not isinstance(scene, int) or not 0 <= scene < SCENE_COUNT:
            raise ValueError(f"Scene must be an integer from 0 through {SCENE_COUNT - 1}.")
        if isinstance(color, bool) or not isinstance(color, int) or not 0 <= color <= 0xFFFFFFFF:
            raise ValueError("Scene color must be an ARGB integer from 0 through 4294967295.")

        qc = self._require_session()
        self._assert_expected_preset(expected_preset_name)
        qc.set_scene_color(scene, color)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            current = qc.read_current_preset()
            if int(list(current.scene_colors)[scene]) == color:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Scene-color readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"Scene {chr(65 + scene)} color updated and verified",
                    "snapshot": self.snapshot(),
                }
            time.sleep(0.1)
        raise RuntimeError("The scene-color command was sent, but readback did not confirm the requested color.")

    def toggle_bypass(
        self,
        row: int,
        column: int,
        expected_scene: int,
        expected_bypassed: bool,
        desired_bypassed: bool,
        expected_preset_name: str = "",
    ) -> dict[str, Any]:
        for label, value, maximum in (("row", row, GRID_ROWS - 1), ("column", column, GRID_COLUMNS - 1), ("scene", expected_scene, SCENE_COUNT - 1)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if not isinstance(expected_bypassed, bool) or not isinstance(desired_bypassed, bool):
            raise ValueError("Expected and desired bypass states must be true or false.")

        pyquadcortex = _protocol_api()

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
        native_command = getattr(getattr(qc, "_t", None), "set_bypass", None)
        if native_command is not None:
            native_command(row, column, desired_bypassed)
        else:
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
            ("row", row, GRID_ROWS - 1),
            ("source column", from_column, GRID_COLUMNS - 1),
            ("destination column", to_column, GRID_COLUMNS - 1),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if from_column == to_column:
            raise ValueError("Choose a different destination column.")
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id <= 0:
            raise ValueError("Expected model ID must be a positive integer.")

        pyquadcortex = _protocol_api()

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

        native_move = _native_transport_method(qc, "move_block")
        if native_move is not None:
            native_move(row, from_column, row, to_column)
        else:
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
        for label, value, maximum in (("row", row, GRID_ROWS - 1), ("column", column, GRID_COLUMNS - 1)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if isinstance(model_id, bool) or not isinstance(model_id, int) or model_id <= 0:
            raise ValueError("Model ID must be a positive integer.")

        pyquadcortex = _protocol_api()

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        if any(block.row == row and block.column == column for block in pyquadcortex.blocks(preset)):
            raise RuntimeError(f"Row {row + 1}, column {column + 1} is no longer empty. Refresh and retry.")
        model = self._ensure_catalog().get(model_id)
        if model is None or model.hidden or model.internal or model.category_hidden or model.superseded:
            raise RuntimeError("The selected model is not available for new blocks on this Quad Cortex.")

        native_set = _native_transport_method(qc, "set_block")
        if native_set is not None:
            native_set(row, column, model_id)
        else:
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
        for label, value, maximum in (("row", row, GRID_ROWS - 1), ("column", column, GRID_COLUMNS - 1)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id <= 0:
            raise ValueError("Expected model ID must be a positive integer.")

        pyquadcortex = _protocol_api()

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        block = next(
            (candidate for candidate in pyquadcortex.blocks(preset) if candidate.row == row and candidate.column == column),
            None,
        )
        if block is None or int(block.model_id) != expected_model_id:
            raise RuntimeError("The selected block changed on the Quad Cortex. Refresh and retry.")
        model = self._ensure_catalog().get(expected_model_id)
        native_remove = _native_transport_method(qc, "remove_block")
        if native_remove is not None:
            native_remove(row, column)
        else:
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
        for label, value, maximum in (("row", row, GRID_ROWS - 1), ("column", column, GRID_COLUMNS - 1)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        for label, value in (("footswitch", footswitch), ("expected footswitch", expected_footswitch)):
            if value is not None and (isinstance(value, bool) or not isinstance(value, int) or not 0 <= value < SCENE_COUNT):
                raise ValueError(f"{label.capitalize()} must be null or an integer from 0 through {SCENE_COUNT - 1}.")
        if isinstance(expected_model_id, bool) or not isinstance(expected_model_id, int) or expected_model_id <= 0:
            raise ValueError("Expected model ID must be a positive integer.")

        pyquadcortex = _protocol_api()

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

        native_footswitch = _native_transport_method(qc, "set_footswitch")
        if native_footswitch is not None:
            native_footswitch(row, column, footswitch)
        elif footswitch is None:
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

    def set_stomp_momentary(
        self, footswitch: int, momentary: bool, expected_preset_name: str,
    ) -> dict[str, Any]:
        """Set single-target STOMP latch behavior and verify preset readback."""
        if isinstance(footswitch, bool) or not isinstance(footswitch, int) or not 0 <= footswitch < SCENE_COUNT:
            raise ValueError(f"Footswitch must be an integer from 0 through {SCENE_COUNT - 1}.")
        if not isinstance(momentary, bool):
            raise ValueError("Momentary must be true or false.")
        pyquadcortex = _protocol_api()
        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        targets = [item for item in pyquadcortex.stomp_assignments(preset) if int(item.footswitch) == footswitch]
        if len(targets) != 1:
            raise RuntimeError("Momentary mode requires a footswitch assigned to exactly one block.")
        current = bool(dict(preset.stomp_is_momentary).get(footswitch, False))
        if current == momentary:
            return {"detail": "STOMP momentary behavior was already current", "snapshot": self.snapshot()}
        _pyquadcortex_method(qc, "set_stomp_momentary")(footswitch, momentary)
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            current_preset = qc.read_current_preset()
            if bool(dict(current_preset.stomp_is_momentary).get(footswitch, False)) == momentary:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("STOMP momentary readback matched, but the device did not mark the preset dirty.")
                return {"detail": "STOMP momentary behavior applied and verified", "snapshot": self.snapshot()}
        raise RuntimeError("STOMP momentary command was sent, but readback did not confirm it.")

    def set_stomp_label(
        self, footswitch: int, label: str, expected_preset_name: str,
    ) -> dict[str, Any]:
        """Set the correct single- or multi-assignment STOMP label and verify it."""
        if isinstance(footswitch, bool) or not isinstance(footswitch, int) or not 0 <= footswitch < SCENE_COUNT:
            raise ValueError(f"Footswitch must be an integer from 0 through {SCENE_COUNT - 1}.")
        if not isinstance(label, str) or len(label) > 32 or any(ord(character) < 32 or ord(character) == 127 for character in label):
            raise ValueError("STOMP label must contain at most 32 non-control characters.")
        pyquadcortex = _protocol_api()
        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        targets = [item for item in pyquadcortex.stomp_assignments(preset) if int(item.footswitch) == footswitch]
        if not targets:
            raise RuntimeError("The selected footswitch has no STOMP assignment.")
        single = len(targets) == 1
        labels = dict(preset.single_stomp_labels if single else preset.stomp_labels)
        if labels.get(footswitch, "") == label:
            return {"detail": "STOMP label was already current", "snapshot": self.snapshot()}
        _pyquadcortex_method(qc, "set_stomp_label")(footswitch, label, single=single)
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            current_preset = qc.read_current_preset()
            current_labels = dict(current_preset.single_stomp_labels if single else current_preset.stomp_labels)
            if current_labels.get(footswitch, "") == label:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("STOMP label readback matched, but the device did not mark the preset dirty.")
                return {"detail": "STOMP label applied and verified", "snapshot": self.snapshot()}
        raise RuntimeError("STOMP label command was sent, but readback did not confirm it.")

    @staticmethod
    def _validated_midi_messages(messages: Any) -> list[dict[str, int]]:
        if not isinstance(messages, list) or len(messages) > 12:
            raise ValueError("MIDI Out messages must be a list containing at most 12 entries.")
        normalized = []
        limits = {"type": (1, 3), "channel": (1, 16), "param1": (0, 127), "param2": (0, 127), "param3": (0, 127)}
        for message in messages:
            if not isinstance(message, dict) or set(message) != set(limits):
                raise ValueError("Each MIDI Out message must contain only type, channel, param1, param2, and param3.")
            current = {}
            for field, (minimum, maximum) in limits.items():
                value = message[field]
                if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                    raise ValueError(f"MIDI Out {field} must be an integer from {minimum} through {maximum}.")
                current[field] = value
            normalized.append(current)
        return normalized

    @staticmethod
    def _midi_message_values(messages: Any) -> list[tuple[int, int, int, int, int]]:
        return [(int(item.type), int(item.channel), int(item.param1), int(item.param2), int(item.param3)) for item in messages]

    def set_midi_out(
        self, source: int, messages: Any, expected_preset_name: str,
    ) -> dict[str, Any]:
        """Replace one preset MIDI Out source and verify preset readback."""
        if isinstance(source, bool) or not isinstance(source, int) or not 0 <= source <= 9:
            raise ValueError("MIDI Out source must be an integer from 0 through 9.")
        return self._set_preset_midi_out(source, messages, expected_preset_name)

    def set_preset_load_midi_out(
        self, messages: Any, expected_preset_name: str,
    ) -> dict[str, Any]:
        """Replace preset-load MIDI Out messages and verify preset readback."""
        return self._set_preset_midi_out(None, messages, expected_preset_name)

    def _set_preset_midi_out(
        self, source: int | None, messages: Any, expected_preset_name: str,
    ) -> dict[str, Any]:
        normalized = self._validated_midi_messages(messages)
        pyquadcortex = _protocol_api()
        qc = self._require_session()
        self._assert_expected_preset(expected_preset_name)
        encoded = [pyquadcortex.MidiOut(**message) for message in normalized]
        expected = [tuple(message[field] for field in ("type", "channel", "param1", "param2", "param3")) for message in normalized]
        if source is None:
            _pyquadcortex_method(qc, "set_preset_load_midi_out")(encoded)
        else:
            _pyquadcortex_method(qc, "set_midi_out")(source, encoded)
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            preset = qc.read_current_preset()
            actual = pyquadcortex.preset_load_midi_out(preset) if source is None else pyquadcortex.midi_out(preset, source)
            if self._midi_message_values(actual) == expected:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("MIDI Out readback matched, but the device did not mark the preset dirty.")
                kind = "Preset-load MIDI Out" if source is None else f"MIDI Out source {source}"
                return {"detail": f"{kind} applied and verified", "snapshot": self.snapshot()}
        raise RuntimeError("MIDI Out command was sent, but readback did not confirm it.")

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

        pyquadcortex = _protocol_api()

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

        native_route = _native_transport_method(qc, f"set_chain_{route_kind}")
        if native_route is not None:
            native_route(row, route_id)
        elif route_kind == "input":
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
            if isinstance(split, bool) or not isinstance(split, int) or not 0 <= split < GRID_COLUMNS:
                raise ValueError(f"{label} split column must be null or an integer from 0 through {GRID_COLUMNS - 1}.")
            if isinstance(mix, bool) or not isinstance(mix, int) or mix not in range(-1, GRID_COLUMNS):
                raise ValueError(f"{label} mix column must be -1 or an integer from 0 through {GRID_COLUMNS - 1}.")
            if mix != -1 and mix <= split:
                raise ValueError(f"{label} rejoin column must follow the split column.")

        validate_pair(split_column, mix_column, "Requested")
        validate_pair(expected_split_column, expected_mix_column, "Expected")

        pyquadcortex = _protocol_api()

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

        native_split = _native_transport_method(qc, "set_chain_split")
        if native_split is not None:
            native_split(row, split_column, mix_column)
        elif split_column is None:
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

    def set_split_mute(
        self, row: int, muted: bool, expected_muted: bool, expected_preset_name: str
    ) -> dict[str, Any]:
        if isinstance(row, bool) or row not in (0, 2):
            raise ValueError("Splitter/mixer controls are available only on rows 1 and 3.")
        if not isinstance(muted, bool) or not isinstance(expected_muted, bool):
            raise ValueError("muted and expected_muted must be booleans")

        pyquadcortex = _protocol_api()
        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)

        def read_mute(current_preset: Any) -> bool:
            for index, chain in enumerate(current_preset.chains):
                chain_row = chain.row if pyquadcortex.field_present(chain, "row") else index
                if chain_row == row:
                    return bool(chain.mixBypass[0].bypass) if chain.mixBypass else False
            raise RuntimeError("The requested splitter/mixer row is absent from device readback.")

        if read_mute(preset) != expected_muted:
            raise RuntimeError("The splitter/mixer mute state changed on the Quad Cortex. Refresh and retry.")
        if muted == expected_muted:
            state = "muted" if muted else "unmuted"
            return {"detail": f"Row {row + 1} splitter/mixer was already {state}", "snapshot": self.snapshot()}

        native_mute = _native_transport_method(qc, "set_split_mute")
        if native_mute is not None:
            native_mute(row, muted)
        else:
            qc.set_split_mute(row, muted)
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            if read_mute(qc.read_current_preset()) == muted:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Splitter/mixer mute readback matched, but the device did not mark the preset dirty.")
                state = "muted" if muted else "unmuted"
                return {"detail": f"Row {row + 1} splitter/mixer {state} and verified", "snapshot": self.snapshot()}
        raise RuntimeError("The splitter/mixer mute command was sent, but readback did not confirm it.")

    def _routing_node_details(
        self, preset: Any, row: int, column: int, scene: int
    ) -> dict[str, Any]:
        pyquadcortex = _protocol_api()

        node = ROUTING_NODE_COLUMNS[column]
        split = next((item for item in pyquadcortex.splits(preset) if item.row == row), None)
        if split is None or (node == "mixer" and not split.rejoins):
            raise RuntimeError(f"There is no {node} on signal line {row + 1}.")
        collection = preset.chains[row].combined_splitter if node == "splitter" else preset.chains[row].mixer
        if not collection:
            raise RuntimeError(f"The Quad Cortex did not report {node} parameter state for signal line {row + 1}.")
        qc = self._require_session()
        model_id = ROUTING_NODE_MODELS[node]
        model = self._ensure_catalog().get(model_id)
        if model is None:
            raise RuntimeError(f"Model metadata is unavailable for the {node}.")
        stored_model = collection[0]
        current_values: dict[int, float | None] = {}
        controller_steps = {spec.index: spec.steps for spec in model.parameters}
        for spec in model.parameters:
            if spec.index >= len(stored_model.params):
                current_values[spec.index] = None
                continue
            stored_parameter = stored_model.params[spec.index]
            values = [
                item.string_value if item.HasField("string_value") else item.float_value if item.HasField("float_value") else None
                for item in stored_parameter.param_values
            ]
            state = pyquadcortex.ParamState(bool(stored_parameter.scene_mode), tuple(values))
            value = _effective_parameter_value(state, scene)
            current_values[spec.index] = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
        visible_indexes: set[int] | None = None
        if node == "splitter" and stored_model.params:
            type_values = [item.float_value for item in stored_model.params[0].param_values if item.HasField("float_value")]
            split_type = type_values[scene] if stored_model.params[0].scene_mode and scene < len(type_values) else (type_values[0] if type_values else 0.0)
            visible_indexes = ({0, 1, 3, 4}, {0, 1, 2}, {0, 1, 5, 6})[max(0, min(2, round(split_type * 2)))]
        parameters = []
        for spec in model.parameters:
            metadata: dict[str, Any] = {}
            if metadata.get("hidden") or metadata.get("screenVisible") is False:
                continue
            if visible_indexes is not None and spec.index not in visible_indexes:
                continue
            if node == "mixer" and spec.name == "SPLIT MODE":
                continue
            if spec.index >= len(stored_model.params):
                continue
            stored_parameter = stored_model.params[spec.index]
            values = []
            for item in stored_parameter.param_values:
                if item.HasField("string_value"):
                    values.append(item.string_value)
                elif item.HasField("float_value"):
                    values.append(item.float_value)
                else:
                    values.append(None)
            state = pyquadcortex.ParamState(bool(stored_parameter.scene_mode), tuple(values))
            value = _effective_parameter_value(state, scene)
            dynamic_options = list(stored_parameter.dynamic_steps)
            options = dynamic_options or ROUTING_PARAMETER_OPTIONS.get((node, spec.index), [])
            display_metadata = self._parameter_display_metadata(model_id, spec.index, spec, list(options))
            normalized_value, writable = _editor_parameter_state(value, list(options), spec.type)
            if options and normalized_value is not None:
                display_value = str(pyquadcortex.option_at(options, normalized_value))
            elif normalized_value is not None:
                if display_metadata["scaleKnown"]:
                    precision = display_metadata["displayPrecision"]
                    display_value = _format_parameter_number(normalized_value, precision)
                else:
                    display_value = f"{normalized_value:.3f}".rstrip("0").rstrip(".")
            else:
                display_value = str(value or "")
            parameters.append(
                {
                    "index": spec.index,
                    "name": (spec.name or f"Parameter {spec.index}").replace("_", " "),
                    "normalizedValue": normalized_value,
                    "displayValue": display_value,
                    "units": display_metadata.get("units", spec.units),
                    "type": spec.type,
                    "minimum": display_metadata["minimum"],
                    "maximum": display_metadata["maximum"],
                    "valueScale": display_metadata["valueScale"],
                    "scaleExponent": display_metadata["scaleExponent"],
                    "scalePoints": display_metadata.get("scalePoints", []),
                    "displayPrecision": display_metadata["displayPrecision"],
                    "scaleKnown": display_metadata["scaleKnown"],
                    "minimumLabel": display_metadata.get("minimumLabel"),
                    "midpointLabel": display_metadata.get("midpointLabel"),
                    "maximumLabel": display_metadata.get("maximumLabel"),
                    "displayPosition": display_metadata.get("displayPosition", spec.index),
                    "steps": spec.steps,
                    "sceneMode": bool(state.scene_mode),
                    "options": list(options),
                    "writable": writable,
                    "enabled": _parameter_enabled(display_metadata, current_values, controller_steps),
                    "expressionAssignable": display_metadata.get("expressionAssignable", True),
                    "linkedSceneMode": display_metadata.get("linkedSceneMode"),
                    "expression": None,
                    "expressionMinimum": None,
                    "expressionMaximum": None,
                }
            )
        result = {
            "row": row,
            "column": column,
            "modelId": model_id,
            "name": model.name,
            "category": _device_type_name(model.category),
            "scene": scene,
            "parameters": parameters,
        }
        self._live_editor_context = {
            "row": row,
            "column": column,
            "scene": scene,
            "presetName": preset.name or "",
            "parameters": {
                int(parameter["index"]): float(parameter["normalizedValue"])
                for parameter in parameters
                if parameter["writable"]
                and parameter["normalizedValue"] is not None
                and not parameter["options"]
            },
        }
        return result

    def preview_parameter(
        self,
        row: int,
        column: int,
        parameter_index: int,
        value: float,
        expected_value: float,
        expected_scene: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        """Stream a continuous knob value without any blocking device read.

        The final set_parameter call still performs full optimistic-concurrency
        checks and stable readback. This path exists only to make physical QC
        tracking follow pointer motion in real time.
        """
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0.0 <= value <= 1.0:
            raise ValueError("Parameter value must be a normalized number from 0 through 1.")
        if isinstance(expected_value, bool) or not isinstance(expected_value, (int, float)) or not 0.0 <= expected_value <= 1.0:
            raise ValueError("Expected parameter value must be a normalized number from 0 through 1.")
        if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
            raise ValueError("Parameter index must be a non-negative integer.")
        context = self._live_editor_context
        expected_name_matches = bool(context) and (
            context["presetName"] == expected_preset_name
            or (not context["presetName"] and expected_preset_name.casefold() in {"current preset", "empty preset", "unsaved"})
        )
        if (
            not context
            or context["row"] != row
            or context["column"] != column
            or context["scene"] != expected_scene
            or not expected_name_matches
            or parameter_index not in context["parameters"]
            or abs(context["parameters"][parameter_index] - float(expected_value)) > 0.00001
        ):
            raise RuntimeError("The live parameter context changed. Reopen the block and retry.")
        qc = self._require_session()
        native_command = getattr(getattr(qc, "_t", None), "set_parameter", None)
        if native_command is not None:
            native_command(row, column, parameter_index, value=float(value))
        else:
            qc.set_param(row, column, param_index=parameter_index, value=float(value))
        return {
            "detail": "Latest drag value sent to the Quad Cortex",
            "acceptedValue": float(value),
        }

    def block_details(
        self, row: int, column: int, expected_preset_name: str = ""
    ) -> BlockDetails:
        for label, value, maximum in (("row", row, 3), ("column", column, 9)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")

        qc = self._require_session()
        native_reader = getattr(getattr(qc, "_t", None), "block_details", None)
        if native_reader is not None:
            native = native_reader(row, column, expected_preset_name)
            if native is not None:
                self._live_editor_context = {
                    "row": row,
                    "column": column,
                    "scene": int(native["scene"]),
                    "presetName": expected_preset_name,
                    "parameters": {
                        int(parameter["index"]): float(parameter["normalizedValue"])
                        for parameter in native["parameters"]
                        if parameter.get("writable")
                        and parameter.get("normalizedValue") is not None
                        and not parameter.get("options")
                    },
                }
                return native

        pyquadcortex = _protocol_api()

        preset = self._assert_expected_preset(expected_preset_name)
        scene = int(qc.active_scene())
        if column in ROUTING_NODE_COLUMNS:
            return self._routing_node_details(preset, row, column, scene)
        block = next(
            (candidate for candidate in pyquadcortex.blocks(preset) if candidate.row == row and candidate.column == column),
            None,
        )
        if block is None:
            raise RuntimeError(f"There is no block at row {row + 1}, column {column + 1}.")
        model = self._ensure_catalog().get(block.model_id)
        if model is None:
            raise RuntimeError(f"Model metadata is unavailable for block {block.model_id}.")

        current_values: dict[int, float | None] = {}
        controller_steps = {spec.index: spec.steps for spec in model.parameters}
        for spec in model.parameters:
            try:
                state = pyquadcortex.param_state(preset, row, column, spec.index)
                value = _effective_parameter_value(state, scene)
                current_values[spec.index] = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None
            except (IndexError, AttributeError):
                current_values[spec.index] = None

        parameters = []
        cab_model = "cabsim" in model.category.casefold() or " cab" in _device_type_name(model.category).casefold()
        ir_loader_model = "irloader" in re.sub(r"[^a-z0-9]+", "", model.category.casefold())
        for spec in model.parameters:
            metadata: dict[str, Any] = {}
            if metadata.get("hidden") or (metadata.get("screenVisible") is False and not (cab_model or ir_loader_model)) or _conditional_parameter_hidden(block.model_id, spec.index, current_values):
                continue
            try:
                state = pyquadcortex.param_state(preset, row, column, spec.index)
                value = _effective_parameter_value(state, scene)
                stored_parameter = preset.chains[row].models[column].params[spec.index]
            except (IndexError, AttributeError):
                continue
            options = pyquadcortex.param_options(preset, row, column, spec.index)
            if not options and spec.index in (1, 9):
                options = _cab_microphone_options(block.model_id, value)
            display_metadata = self._parameter_display_metadata(block.model_id, spec.index, spec, list(options))
            numeric = isinstance(value, (int, float)) and not isinstance(value, bool)
            text_option = isinstance(value, str) and bool(options) and value in options
            normalized_value, writable = _editor_parameter_state(value, list(options), spec.type)
            display_value: str
            if text_option:
                display_value = str(value)
            elif options and numeric:
                try:
                    display_value = str(pyquadcortex.option_at(options, float(value)))
                except (ValueError, IndexError):
                    display_value = f"{float(value):.3f}"
            elif writable:
                if display_metadata["scaleKnown"]:
                    precision = display_metadata["displayPrecision"]
                    display_value = _format_parameter_number(float(value), precision)
                else:
                    display_value = f"{float(value):.3f}".rstrip("0").rstrip(".")
            else:
                display_value = str(value or "")
            parameters.append(
                {
                    "index": spec.index,
                    "name": (spec.name or f"Parameter {spec.index}").replace("_", " "),
                    "normalizedValue": normalized_value,
                    "displayValue": display_value,
                    "units": display_metadata.get("units", spec.units),
                    "type": spec.type,
                    "minimum": display_metadata["minimum"],
                    "maximum": display_metadata["maximum"],
                    "valueScale": display_metadata["valueScale"],
                    "scaleExponent": display_metadata["scaleExponent"],
                    "scalePoints": display_metadata.get("scalePoints", []),
                    "displayPrecision": display_metadata["displayPrecision"],
                    "scaleKnown": display_metadata["scaleKnown"],
                    "minimumLabel": display_metadata.get("minimumLabel"),
                    "midpointLabel": display_metadata.get("midpointLabel"),
                    "maximumLabel": display_metadata.get("maximumLabel"),
                    "displayPosition": display_metadata.get("displayPosition", spec.index),
                    "steps": spec.steps,
                    "sceneMode": bool(state.scene_mode),
                    "options": list(options),
                    "writable": writable,
                    "enabled": _parameter_enabled(display_metadata, current_values, controller_steps),
                    "expressionAssignable": display_metadata.get("expressionAssignable", True),
                    "linkedSceneMode": display_metadata.get("linkedSceneMode"),
                    "expression": (
                        int(stored_parameter.expression)
                        if pyquadcortex.field_present(stored_parameter, "expression")
                        else None
                    ),
                    "expressionMinimum": (
                        float(stored_parameter.expression_min)
                        if pyquadcortex.field_present(stored_parameter, "expression_min")
                        else None
                    ),
                    "expressionMaximum": (
                        float(stored_parameter.expression_max)
                        if pyquadcortex.field_present(stored_parameter, "expression_max")
                        else None
                    ),
                }
            )
        result = {
            "row": row,
            "column": column,
            "modelId": block.model_id,
            "name": model.name,
            "category": _device_type_name(model.category),
            "scene": scene,
            "parameters": parameters,
        }
        self._live_editor_context = {
            "row": row,
            "column": column,
            "scene": scene,
            "presetName": preset.name or "",
            "parameters": {
                int(parameter["index"]): float(parameter["normalizedValue"])
                for parameter in parameters
                if parameter["writable"]
                and parameter["normalizedValue"] is not None
                and not parameter["options"]
            },
        }
        return result

    def lane_control_details(
        self, row: int, control: str, expected_preset_name: str = ""
    ) -> BlockDetails:
        if isinstance(row, bool) or not isinstance(row, int) or not 0 <= row < 4:
            raise ValueError("Expected row must be an integer from 0 through 3.")
        if control not in ("inputGate", "laneOutput"):
            raise ValueError("Control must be inputGate or laneOutput.")
        qc = self._require_session()
        native = getattr(getattr(qc, "_t", None), "lane_control_details", None)
        if native is not None:
            return native(row, control, expected_preset_name)

        pyquadcortex = _protocol_api()
        preset = self._assert_expected_preset(expected_preset_name)
        scene = int(qc.active_scene())
        chain = next(
            (candidate for index, candidate in enumerate(preset.chains)
             if (candidate.row if pyquadcortex.field_present(candidate, "row") else index) == row),
            None,
        )
        if chain is None:
            raise RuntimeError(f"Signal row {row + 1} is unavailable in the active preset.")
        collection = chain.input_control if control == "inputGate" else chain.output_control
        model_id = 28_000 if control == "inputGate" else 23_000
        if not collection:
            raise RuntimeError(f"The Quad Cortex did not report {control} state for row {row + 1}.")
        catalog_model = self._ensure_catalog().get(model_id)
        if catalog_model is None:
            raise RuntimeError(f"Model metadata is unavailable for {control}.")
        specs = {spec.index: spec for spec in catalog_model.parameters}
        parameters = []
        for position, stored in enumerate(collection[0].params):
            index = int(stored.index) if pyquadcortex.field_present(stored, "index") else position
            spec = specs.get(index)
            if spec is None:
                continue
            values = [
                item.string_value if item.HasField("string_value") else
                item.float_value if item.HasField("float_value") else None
                for item in stored.param_values
            ]
            state = pyquadcortex.ParamState(bool(stored.scene_mode), tuple(values))
            value = _effective_parameter_value(state, scene)
            options = list(stored.dynamic_steps)
            metadata = self._parameter_display_metadata(model_id, index, spec, options)
            normalized_value, writable = _editor_parameter_state(value, options, spec.type)
            display_value = (
                str(pyquadcortex.option_at(options, normalized_value))
                if options and normalized_value is not None else
                _format_parameter_number(normalized_value, metadata["displayPrecision"])
                if normalized_value is not None and metadata["scaleKnown"] else
                str(value or "")
            )
            parameters.append({
                "index": index, "name": (spec.name or f"Parameter {index}").replace("_", " "),
                "normalizedValue": normalized_value, "displayValue": display_value,
                "units": metadata.get("units", spec.units), "type": spec.type,
                "minimum": metadata["minimum"], "maximum": metadata["maximum"],
                "valueScale": metadata["valueScale"], "scaleExponent": metadata["scaleExponent"],
                "scalePoints": metadata.get("scalePoints", []),
                "displayPrecision": metadata["displayPrecision"], "scaleKnown": metadata["scaleKnown"],
                "minimumLabel": metadata.get("minimumLabel"), "midpointLabel": metadata.get("midpointLabel"),
                "maximumLabel": metadata.get("maximumLabel"),
                "displayPosition": metadata.get("displayPosition", index), "steps": spec.steps,
                "sceneMode": bool(state.scene_mode), "options": options, "writable": writable,
                "enabled": True, "expressionAssignable": False, "linkedSceneMode": None,
                "expression": None, "expressionMinimum": None, "expressionMaximum": None,
            })
        return {
            "row": row, "column": 10 if control == "inputGate" else 11,
            "modelId": model_id, "name": catalog_model.name,
            "category": _device_type_name(catalog_model.category), "scene": scene,
            "parameters": parameters,
        }

    def preview_lane_control_parameter(
        self, row: int, control: str, parameter_index: int, value: float,
        expected_value: float, expected_preset_name: str = "",
    ) -> dict[str, Any]:
        details = self.lane_control_details(row, control, expected_preset_name)
        parameter = next((item for item in details["parameters"] if item["index"] == parameter_index), None)
        if parameter is None or not parameter["writable"]:
            raise RuntimeError("The selected lane control no longer exposes that writable parameter.")
        if parameter["normalizedValue"] is None or abs(float(parameter["normalizedValue"]) - float(expected_value)) > 0.001:
            raise RuntimeError("The lane control changed on the Quad Cortex. Refresh and retry.")
        qc = self._require_session()
        native = getattr(getattr(qc, "_t", None), "preview_lane_control_parameter", None)
        if native is not None:
            return native(row=row, control=control, parameterIndex=parameter_index, value=float(value),
                          expectedValue=float(expected_value),
                          expectedPresetName=expected_preset_name)
        setter = qc.set_input_gate if control == "inputGate" else qc.set_lane_output
        setter(row, parameter_index, value=float(value))
        return {"detail": "Lane control parameter preview sent", "acceptedValue": float(value)}

    def set_lane_control_parameter(
        self, row: int, control: str, parameter_index: int, value: float,
        expected_value: float, expected_preset_name: str = "",
    ) -> dict[str, Any]:
        details = self.lane_control_details(row, control, expected_preset_name)
        parameter = next((item for item in details["parameters"] if item["index"] == parameter_index), None)
        if parameter is None or parameter["normalizedValue"] is None:
            raise RuntimeError("The selected lane control no longer exposes that parameter.")
        if abs(float(parameter["normalizedValue"]) - float(expected_value)) > 0.001:
            raise RuntimeError("The lane control changed on the Quad Cortex. Refresh and retry.")
        qc = self._require_session()
        native = getattr(getattr(qc, "_t", None), "set_lane_control_parameter", None)
        if native is not None:
            return native(row=row, control=control, parameterIndex=parameter_index, value=float(value),
                          expectedValue=float(expected_value), expectedPresetName=expected_preset_name)
        setter = qc.set_input_gate if control == "inputGate" else qc.set_lane_output
        setter(row, parameter_index, value=float(value))
        return {"detail": "Lane control parameter update sent", "block": self.lane_control_details(row, control, expected_preset_name)}

    def set_lane_control_scene_mode(
        self, row: int, control: str, parameter_index: int, enabled: bool,
        expected_preset_name: str = "",
    ) -> dict[str, Any]:
        details = self.lane_control_details(row, control, expected_preset_name)
        if not any(item["index"] == parameter_index for item in details["parameters"]):
            raise RuntimeError("The selected lane control no longer exposes that parameter.")
        qc = self._require_session()
        native = getattr(getattr(qc, "_t", None), "set_lane_control_scene_mode", None)
        if native is not None:
            return native(row=row, control=control, parameterIndex=parameter_index, enabled=bool(enabled),
                          expectedPresetName=expected_preset_name)
        if control == "laneOutput":
            qc.set_lane_output_scene_mode(row, parameter_index, bool(enabled))
        else:
            current = next(item for item in details["parameters"] if item["index"] == parameter_index)["normalizedValue"]
            if not enabled:
                raise RuntimeError("Clearing Input Gate scene mode requires the native Rust runtime.")
            qc.set_input_gate(row, parameter_index, value=float(current), scene=int(qc.active_scene()), promote=True)
        return {"detail": "Lane control scene behavior updated", "block": self.lane_control_details(row, control, expected_preset_name)}

    def _set_routing_parameter(
        self,
        preset: Any,
        row: int,
        column: int,
        parameter_index: int,
        value: float,
        expected_value: float,
        scene: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        pyquadcortex = _protocol_api()

        node = ROUTING_NODE_COLUMNS[column]
        details = self._routing_node_details(preset, row, column, scene)
        parameter = next((item for item in details["parameters"] if item["index"] == parameter_index), None)
        if parameter is None or parameter["normalizedValue"] is None:
            raise RuntimeError(f"The selected {node} no longer exposes that parameter.")
        options = parameter["options"]
        if not pyquadcortex.params_equal(float(parameter["normalizedValue"]), float(expected_value), len(options) or None):
            raise RuntimeError(f"The {node} parameter changed on the Quad Cortex. Refresh and retry.")

        qc = self._require_session()
        native_routing = _native_transport_method(qc, "set_routing_parameter")
        if native_routing is not None:
            native_routing(row, node, parameter_index, float(value))
        elif node == "splitter":
            qc.set_splitter_param(row, parameter_index, value=float(value))
        else:
            qc.set_mixer_param(row, parameter_index, value=float(value))
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            current_preset = qc.read_current_preset()
            current = self._routing_node_details(current_preset, row, column, scene)
            actual = next((item for item in current["parameters"] if item["index"] == parameter_index), None)
            if actual is not None and actual["normalizedValue"] is not None and pyquadcortex.params_equal(
                float(actual["normalizedValue"]), float(value), len(actual["options"]) or None
            ):
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Routing parameter readback matched, but the device did not mark the preset dirty.")
                return {
                    "detail": f"{node.title()} parameter change applied and verified",
                    "block": current,
                }
        raise RuntimeError(f"The {node} parameter command was sent, but readback did not confirm the requested value.")

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

        pyquadcortex = _protocol_api()

        qc = self._require_session()
        preset = self._assert_expected_preset(expected_preset_name)
        actual_scene = int(qc.active_scene())
        if actual_scene != expected_scene:
            raise RuntimeError(
                f"Scene changed on the Quad Cortex: expected {chr(65 + expected_scene)}, "
                f"but {chr(65 + actual_scene)} is active. Refresh and retry."
            )
        if column in ROUTING_NODE_COLUMNS:
            return self._set_routing_parameter(
                preset, row, column, parameter_index, value, expected_value,
                actual_scene, expected_preset_name
            )
        block = next(
            (candidate for candidate in pyquadcortex.blocks(preset) if candidate.row == row and candidate.column == column),
            None,
        )
        if block is None:
            raise RuntimeError(f"There is no block at row {row + 1}, column {column + 1}.")
        native_reader = getattr(getattr(qc, "_t", None), "block_details", None)
        native_block = native_reader(row, column, expected_preset_name) if native_reader is not None else None
        native_parameter = next(
            (item for item in (native_block or {}).get("parameters", []) if item["index"] == parameter_index),
            None,
        )
        if native_reader is not None:
            if native_parameter is None:
                raise RuntimeError("The selected block no longer exposes that parameter.")
        else:
            model = self._ensure_catalog().get(block.model_id)
            if model is None or not any(spec.index == parameter_index for spec in model.parameters):
                raise RuntimeError("The selected block no longer exposes that parameter.")
        state = pyquadcortex.param_state(preset, row, column, parameter_index)
        current = _effective_parameter_value(state, actual_scene)
        options = pyquadcortex.param_options(preset, row, column, parameter_index)
        if not options and native_parameter is not None:
            options = list(native_parameter.get("options") or [])
        if not options and parameter_index in (1, 9):
            options = _cab_microphone_options(block.model_id, current)
        text_target = None
        if isinstance(current, str):
            if current not in options:
                raise RuntimeError("This text parameter has no selectable option list on the Quad Cortex.")
            current_normalized = 0.0 if len(options) == 1 else options.index(current) / (len(options) - 1)
            if not pyquadcortex.params_equal(current_normalized, float(expected_value), len(options) or None):
                raise RuntimeError("The parameter changed on the Quad Cortex. Refresh the block and retry.")
            text_target = str(pyquadcortex.option_at(options, float(value)))
            native_command = getattr(getattr(qc, "_t", None), "set_parameter", None)
            if native_command is not None:
                native_command(row, column, parameter_index, text=text_target)
            else:
                qc.set_param(row, column, param_index=parameter_index, text=text_target)
        elif isinstance(current, (int, float)) and not isinstance(current, bool):
            already_at_target = pyquadcortex.params_equal(float(current), float(value), len(options) or None)
            if not already_at_target and not pyquadcortex.params_equal(float(current), float(expected_value), len(options) or None):
                raise RuntimeError("The parameter changed on the Quad Cortex. Refresh the block and retry.")
            if not already_at_target:
                native_command = getattr(getattr(qc, "_t", None), "set_parameter", None)
                if native_command is not None:
                    native_command(row, column, parameter_index, value=float(value))
                else:
                    qc.set_param(row, column, param_index=parameter_index, value=float(value))
        else:
            raise RuntimeError("This parameter cannot be changed by the editor.")
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            current_preset = qc.read_current_preset()
            current_state = pyquadcortex.param_state(current_preset, row, column, parameter_index)
            actual = _effective_parameter_value(current_state, actual_scene)
            text_matches = text_target is not None and actual == text_target
            numeric_matches = (
                text_target is None
                and isinstance(actual, (int, float))
                and not isinstance(actual, bool)
                and pyquadcortex.params_equal(float(actual), float(value), len(options) or None)
            )
            if text_matches or numeric_matches:
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Parameter readback matched, but the device did not mark the preset dirty.")
                # block_details performs a fresh preset read. Validating the value
                # in that result provides the second stable read without an
                # additional fixed 250 ms wait or a full-preset snapshot.
                verified_block = self.block_details(row, column, expected_preset_name)
                verified_parameter = next(
                    (item for item in verified_block["parameters"] if item["index"] == parameter_index),
                    None,
                )
                if verified_parameter is None:
                    raise RuntimeError("Parameter write landed, but its final displayed value could not be read.")
                verified_value = verified_parameter.get("normalizedValue")
                verified_text_matches = text_target is not None and verified_parameter.get("displayValue") == text_target
                verified_numeric_matches = (
                    text_target is None
                    and isinstance(verified_value, (int, float))
                    and not isinstance(verified_value, bool)
                    and pyquadcortex.params_equal(float(verified_value), float(value), len(options) or None)
                )
                if not (verified_text_matches or verified_numeric_matches):
                    continue
                display = str(verified_parameter["displayValue"])
                units = str(verified_parameter.get("units") or "")
                if units and units not in display:
                    display = f"{display} {units}"
                return {
                    "detail": f"{verified_parameter['name']} set to {display} and verified by two stable device reads",
                    "block": verified_block,
                }
        raise RuntimeError("The parameter command was sent, but readback did not confirm the requested value.")

    def set_parameter_scene_mode(
        self,
        row: int,
        column: int,
        parameter_index: int,
        enabled: bool,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        """Set per-scene parameter storage and require authoritative readback."""
        self._validate_parameter_assignment(row, column, parameter_index, expected_preset_name)
        if not isinstance(enabled, bool):
            raise ValueError("Enabled must be true or false.")
        qc = self._require_session()
        before = self.block_details(row, column, expected_preset_name)
        parameter = next(item for item in before["parameters"] if item["index"] == parameter_index)
        if bool(parameter["sceneMode"]) == enabled:
            return {"detail": "Parameter scene behavior was already current", "block": before}
        native = _native_transport_method(qc, "set_parameter_scene_mode")
        if native is not None:
            native(row, column, parameter_index, enabled)
        else:
            _pyquadcortex_method(qc, "set_param_scene_mode")(row, column, parameter_index, enabled)
        return self._verify_parameter_assignment(
            row, column, parameter_index, expected_preset_name,
            lambda item: bool(item["sceneMode"]) == enabled,
            "Parameter scene behavior",
        )

    def set_parameter_expression(
        self,
        row: int,
        column: int,
        parameter_index: int,
        pedal: int,
        minimum: float,
        maximum: float,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        """Assign or clear EXP control and require authoritative readback."""
        parameter = self._validate_parameter_assignment(row, column, parameter_index, expected_preset_name)
        if isinstance(pedal, bool) or not isinstance(pedal, int) or pedal not in (0, 1, 2):
            raise ValueError("Expression pedal must be 0 (clear), 1, or 2.")
        for label, value in (("minimum", minimum), ("maximum", maximum)):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError(f"Expression {label} must be a normalized number from 0 through 1.")
        if parameter.get("expressionAssignable") is False:
            raise RuntimeError("The selected parameter cannot be assigned to an expression pedal.")
        qc = self._require_session()
        native = _native_transport_method(qc, "set_parameter_expression")
        if native is not None:
            native(row, column, parameter_index, pedal, float(minimum), float(maximum))
        else:
            _pyquadcortex_method(qc, "set_expression")(
                row, column, parameter_index, pedal, float(minimum), float(maximum)
            )

        def matches(item: dict[str, Any]) -> bool:
            actual_pedal = item.get("expression") or 0
            if actual_pedal != pedal:
                return False
            if pedal == 0:
                return True
            actual_minimum = item.get("expressionMinimum")
            actual_maximum = item.get("expressionMaximum")
            return (
                isinstance(actual_minimum, (int, float))
                and isinstance(actual_maximum, (int, float))
                and abs(float(actual_minimum) - float(minimum)) <= 0.001
                and abs(float(actual_maximum) - float(maximum)) <= 0.001
            )

        return self._verify_parameter_assignment(
            row, column, parameter_index, expected_preset_name, matches,
            "Parameter expression assignment",
        )

    def set_expression_bypass(
        self, row: int, column: int, pedal: int, mode: int, invert: bool,
        delay_ms: int, latch_emulation: bool, expected_preset_name: str,
    ) -> dict[str, Any]:
        """Assign an expression pedal to block bypass and verify preset readback."""
        for label, value, maximum in (("row", row, GRID_ROWS - 1), ("column", column, GRID_COLUMNS - 1)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if pedal not in (1, 2) or isinstance(pedal, bool):
            raise ValueError("Expression pedal must be 1 or 2.")
        if mode not in (0, 1, 2) or isinstance(mode, bool):
            raise ValueError("Expression bypass mode must be STOP (0), SWITCH (1), or HEEL/TOE (2).")
        if isinstance(delay_ms, bool) or not isinstance(delay_ms, int) or not 0 <= delay_ms <= 5000:
            raise ValueError("Expression bypass delay must be 0 through 5000 ms.")
        if not isinstance(invert, bool) or not isinstance(latch_emulation, bool):
            raise ValueError("Invert and latch emulation must be booleans.")
        pyquadcortex = _protocol_api()
        qc = self._require_session()
        self._assert_expected_preset(expected_preset_name)
        _pyquadcortex_method(qc, "set_expression_bypass")(
            row, column, pedal, mode, invert, pyquadcortex.Milliseconds(delay_ms), latch_emulation
        )
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            preset = qc.read_current_preset()
            if row >= len(preset.chains):
                continue
            model = next((item for index, item in enumerate(preset.chains[row].models)
                          if int(item.column if item.HasField("column") else index) == column), None)
            if model is None or not model.bypass_expression or not model.expression_bypass_info:
                continue
            assignment, info = model.bypass_expression[0], model.expression_bypass_info[0]
            if (int(assignment.expression) == pedal and int(info.type) == mode
                    and bool(info.invert) == invert and int(info.delay_ms) == delay_ms
                    and bool(info.latch_emulation) == latch_emulation):
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError("Expression bypass readback matched, but the device did not mark the preset dirty.")
                return {"detail": "Expression bypass assignment applied and verified", "snapshot": self.snapshot()}
        raise RuntimeError("Expression bypass command was sent, but readback did not confirm it.")

    def _validate_parameter_assignment(
        self, row: int, column: int, parameter_index: int, expected_preset_name: str,
    ) -> dict[str, Any]:
        for label, value, maximum in (("row", row, GRID_ROWS - 1), ("column", column, GRID_COLUMNS - 1)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")
        if isinstance(parameter_index, bool) or not isinstance(parameter_index, int) or parameter_index < 0:
            raise ValueError("Parameter index must be a non-negative integer.")
        details = self.block_details(row, column, expected_preset_name)
        parameter = next((item for item in details["parameters"] if item["index"] == parameter_index), None)
        if parameter is None or not parameter.get("writable"):
            raise RuntimeError("The selected block no longer exposes that writable parameter.")
        return parameter

    def _verify_parameter_assignment(
        self, row: int, column: int, parameter_index: int, expected_preset_name: str,
        matches: Any, label: str,
    ) -> dict[str, Any]:
        qc = self._require_session()
        deadline = time.monotonic() + 4.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            block = self.block_details(row, column, expected_preset_name)
            parameter = next((item for item in block["parameters"] if item["index"] == parameter_index), None)
            if parameter is not None and matches(parameter):
                if not _wait_for_dirty(qc, True):
                    raise RuntimeError(f"{label} readback matched, but the device did not mark the preset dirty.")
                return {"detail": f"{label} applied and verified", "block": block}
        raise RuntimeError(f"{label} command was sent, but readback did not confirm the requested state.")

    def set_tempo(
        self,
        bpm: int,
        expected_tempo: int,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        pyquadcortex = _protocol_api()

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
        native_command = getattr(getattr(qc, "_t", None), "set_tempo", None)
        if native_command is not None:
            native_command(bpm)
        else:
            qc.set_tempo_param("TEMPO", value=desired_value)
        deadline = time.monotonic() + 3.0
        stable_reads = 0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            current = qc.read_current_preset()
            actual_value = pyquadcortex.tempo_params(current).get(0)
            if isinstance(actual_value, (int, float)) and abs(float(actual_value) - desired_value) <= 0.0025:
                stable_reads += 1
                if stable_reads >= 2:
                    # Tempo is a live/global performance control on the QC and
                    # does not necessarily dirty the preset. Requiring a dirty
                    # flag turned a successful hardware write into an app error.
                    return {"detail": f"Tempo set to {bpm} BPM and verified on the Quad Cortex"}
            else:
                stable_reads = 0
        raise RuntimeError("The tempo command was sent, but readback did not confirm the requested BPM.")

    def master_volume_state(self) -> dict[str, int]:
        """Read only the live master-volume control without rebuilding the preset snapshot."""
        qc = self._require_session()
        value = round(float(qc.master_volume(timeout=3.0).volume) * 100)
        return {"value": max(0, min(100, value))}

    def set_master_volume(self, value: int, expected_value: int) -> dict[str, Any]:
        """Set the live QC master volume using its displayed 0-100 scale."""
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100:
            raise ValueError("Master Volume must be an integer from 0 through 100.")
        if isinstance(expected_value, bool) or not isinstance(expected_value, int) or not 0 <= expected_value <= 100:
            raise ValueError("Expected Master Volume must be an integer from 0 through 100.")

        qc = self._require_session()
        actual = self.master_volume_state()["value"]
        if abs(actual - expected_value) > 1:
            raise RuntimeError(
                f"Master Volume changed on the Quad Cortex: expected {expected_value}, found {actual}. "
                "The current device value has been restored in QC Control."
            )
        if actual == value:
            return {"detail": f"Master Volume is already {value}", "snapshot": self.snapshot()}

        qc.set_master_volume(value / 100.0)
        # The QC can report the previous value briefly after a host write. Poll
        # quickly until the first authoritative device echo; the dedicated live
        # volume lane continues reconciling it after this command returns.
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline:
            time.sleep(0.04)
            confirmed = self.master_volume_state()["value"]
            if abs(confirmed - value) <= 1:
                return {
                    "detail": f"Master Volume set to {confirmed}; the physical wheel will resume after soft takeover",
                }
        raise RuntimeError("The Master Volume command was sent, but readback did not confirm the requested value.")

    def press_footswitch(
        self,
        index: int,
        expected_mode: str,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        pyquadcortex = _protocol_api()

        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < SCENE_COUNT:
            raise ValueError(f"Footswitch must be an integer from 0 through {SCENE_COUNT - 1}.")
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
        endpoint = _send_qc_midi_cc(FOOTSWITCH_BASE_CONTROLLER + index, MIDI_PRESSED_VALUE)
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

    def tap_tempo(
        self,
        expected_mode: str,
        expected_preset_name: str,
    ) -> dict[str, Any]:
        """Send the dedicated QC Tap Tempo MIDI command (CC#44)."""
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
        endpoint = _send_qc_midi_cc(TAP_TEMPO_CONTROLLER, MIDI_PRESSED_VALUE)
        return {"detail": f"Tap Tempo sent immediately through {endpoint}"}

    def select_mode_slot(self, slot: int, expected_preset_name: str) -> dict[str, Any]:
        """Recall one of the three configured QC mode slots through official MIDI CC#47."""
        if isinstance(slot, bool) or not isinstance(slot, int) or not 0 <= slot <= 2:
            raise ValueError("Mode slot must be 0, 1, or 2.")
        self._assert_expected_preset(expected_preset_name)
        endpoint = _send_qc_midi_cc(MODE_SLOT_CONTROLLER, slot)
        time.sleep(0.35)
        snapshot = self.snapshot()
        return {
            "detail": f"Mode Slot {slot + 1} selected through {endpoint}; device mode verified as {snapshot['mode']}",
            "snapshot": snapshot,
        }

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

    def snapshot(self) -> PresetSnapshot:
        pyquadcortex = _protocol_api()

        qc = self._require_session()
        setlist_key, preset_position, _ = self._current_position(refresh=True)
        preset = qc.read_current_preset()
        active_scene = int(qc.active_scene())
        mode_state = qc.mode()
        mode_value = int(mode_state.mode)
        reported_cycle = list(mode_state.available_modes.modes)
        if reported_cycle:
            self._mode_cycle = [int(value) for value in reported_cycle]
        if not self._mode_cycle:
            self._mode_cycle = [0, 1, 2]
        mode = _normalized_mode_value(mode_value)
        footswitch_modes = _footswitch_modes_value(mode_value)
        mode_slots = []
        for slot, value in enumerate(self._mode_cycle[:3]):
            label = pyquadcortex.describe_mode(value).upper()
            mode_slots.append({
                "slot": slot,
                "label": label,
                "mode": _normalized_mode_value(value),
            })
        master_volume = round(float(qc.master_volume(timeout=3.0).volume) * 100)

        # The device model repository is a separate ~47 KB transfer that can take
        # up to 25 seconds. A live snapshot must not implicitly fetch it: the grid
        # remains usable with stable model ids, while model-aware screens load the
        # catalog explicitly when the user opens them.
        catalog = getattr(qc, "_catalog", None)
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
            model = catalog.get(block.model_id) if catalog is not None else None
            fallback = _factory_model_metadata(int(block.model_id)) if model is None else None
            name = model.name if model else fallback[0] if fallback else f"Model {block.model_id}"
            category = _device_type_name(model.category) if model else fallback[1] if fallback else "Utility"
            try:
                bypass = pyquadcortex.bypass_state(preset, block.row, block.column)
                bypassed = bypass.scenes[active_scene] if bypass.scene_mode else bypass.scenes[0]
            except (IndexError, AttributeError):
                bypassed = False
            blocks.append({
                "id": f"block-{block.row}-{block.column}",
                "modelId": int(block.model_id),
                "categoryId": int(model.category_id) if model else -1,
                "name": name,
                "kind": _block_kind(category),
                "category": category,
                "plugin": bool(model and getattr(model, "plugin_id", None)),
                "pluginId": str(model.plugin_id) if model and getattr(model, "plugin_id", None) else None,
                "row": block.row,
                "column": block.column,
                "bypassed": bypassed,
                "color": _block_color(category, name),
                "footswitch": stomp_by_cell.get((block.row, block.column)),
                "footswitchOrder": stomp_order_by_cell.get((block.row, block.column)),
            })

        block_by_cell = {(block["row"], block["column"]): block for block in blocks}
        momentary = dict(preset.stomp_is_momentary)
        stomp_labels = dict(preset.stomp_labels)
        single_stomp_labels = dict(preset.single_stomp_labels)
        footswitch_states = []
        for index in range(SCENE_COUNT):
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
                "splitMuted": bool(chain.mixBypass[0].bypass) if chain.mixBypass else False,
            }
            split = split_by_row.get(row)
            if split is not None:
                route["splitColumn"] = split.split_column
                route["mixColumn"] = split.mix_column
            routes.append(route)

        labels = list(preset.scene_labels)
        scenes = [(labels[index] if index < len(labels) and labels[index] else f"Scene {chr(65 + index)}") for index in range(SCENE_COUNT)]
        tempo_values = pyquadcortex.tempo_params(preset)
        return {
            "deviceName": "Quad Cortex",
            "presetName": preset.name or "Unsaved",
            "presetLocation": pyquadcortex.position_to_slot(preset_position),
            "presetPosition": preset_position,
            "setlistKey": setlist_key,
            "setlistName": setlist_key.rstrip("/").rsplit("/", 1)[-1],
            "mode": mode,
            "modeSlots": mode_slots,
            "footswitchModes": footswitch_modes,
            "activeScene": active_scene,
            "scenes": scenes,
            "sceneColors": [_argb_to_css(color) for color in list(preset.scene_colors)[:SCENE_COUNT]],
            "footswitchStates": footswitch_states,
            "blocks": blocks,
            "routes": routes,
            "tempo": _tempo_bpm(preset),
            "tempoLedEnabled": tempo_values.get(2, 0.0) >= 0.5,
            "masterVolume": master_volume,
            "dirty": bool(qc.preset_dirty()),
        }
