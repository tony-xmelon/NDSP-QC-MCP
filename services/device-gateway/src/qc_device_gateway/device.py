"""Read-only pyquadcortex adapter owned exclusively by the gateway process."""

from __future__ import annotations

from datetime import datetime, timezone
import time
from typing import Any


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


class PyQuadCortexDevice:
    def __init__(self) -> None:
        self._qc: Any | None = None
        self._connected_at: str | None = None

    @property
    def connected(self) -> bool:
        return self._qc is not None

    def close(self) -> None:
        qc, self._qc = self._qc, None
        self._connected_at = None
        if qc is not None:
            qc.close()

    def reconnect(self) -> dict[str, Any]:
        self.close()
        import pyquadcortex

        self._qc = pyquadcortex.connect()
        self._connected_at = _utc_now()
        return self.connection_state("Quad Cortex handshake complete")

    def reset_session(self) -> dict[str, Any]:
        return self.reconnect()

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
        expected_preset_name: str = "",
    ) -> dict[str, Any]:
        for label, value, maximum in (("row", row, 3), ("column", column, 7), ("scene", expected_scene, 7)):
            if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
                raise ValueError(f"Expected {label} must be an integer from 0 through {maximum}.")

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
        desired = not before_value
        qc.set_bypass(row, column, desired)

        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline:
            time.sleep(0.2)
            current = qc.read_current_preset()
            state = pyquadcortex.bypass_state(current, row, column)
            actual = state.scenes[expected_scene] if state.scene_mode else state.scenes[0]
            if actual == desired:
                return {
                    "detail": f"Block {'bypassed' if desired else 'enabled'} and verified",
                    "snapshot": self.snapshot(),
                }
        raise RuntimeError("The bypass command was sent, but readback did not confirm the requested state.")

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
        version = qc.version()
        active_scene = int(qc.active_scene())
        mode_state = qc.mode()
        try:
            mode = pyquadcortex.describe_mode(mode_state.mode).upper()
        except Exception:
            mode = "PRESET"
        if mode not in {"PRESET", "SCENE", "STOMP", "HYBRID"}:
            mode = "PRESET"

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

        labels = list(preset.scene_labels)
        scenes = [(labels[index] if index < len(labels) and labels[index] else f"Scene {chr(65 + index)}") for index in range(8)]
        device_type = getattr(version, "device_type", "Quad Cortex")
        return {
            "deviceName": str(device_type) if device_type else "Quad Cortex",
            "presetName": preset.name or "Current preset",
            "presetLocation": "LIVE",
            "mode": mode,
            "activeScene": active_scene,
            "scenes": scenes,
            "blocks": blocks,
            "tempo": round(float(preset.tempo or 120)),
            "dirty": bool(qc.preset_dirty()),
        }
