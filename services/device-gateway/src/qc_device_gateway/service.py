"""JSON-RPC dispatch and lifecycle for the persistent QC session."""

from __future__ import annotations

from typing import Any

from .device import PyQuadCortexDevice


class GatewayService:
    def __init__(self, device: Any | None = None) -> None:
        self.device = device or PyQuadCortexDevice()

    def close(self) -> None:
        self.device.close()

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request.get("id")
        if (
            request.get("jsonrpc") != "2.0"
            or not isinstance(request_id, int)
            or isinstance(request_id, bool)
        ):
            return self._error(request_id, -32600, "Invalid JSON-RPC request")
        method = request.get("method")
        params = request.get("params") or {}
        if not isinstance(params, dict):
            return self._error(request_id, -32602, "Method params must be an object")
        try:
            if method == "system.status":
                result = {
                    "platform": "Python device gateway",
                    "gatewayAvailable": True,
                    "message": "Gateway active; guarded live controls and explicitly confirmed preset Save As are available; other persistent writes remain locked.",
                }
            elif method == "device.reconnect":
                result = self.device.reconnect()
            elif method == "device.resetSession":
                result = self.device.reset_session()
            elif method == "device.snapshot":
                result = self.device.snapshot()
            elif method == "device.selectScene":
                result = self.device.select_scene(
                    params.get("scene"), params.get("expectedPresetName", "")
                )
            elif method == "device.toggleBypass":
                result = self.device.toggle_bypass(
                    params.get("row"),
                    params.get("column"),
                    params.get("expectedScene"),
                    params.get("expectedBypassed"),
                    params.get("desiredBypassed"),
                    params.get("expectedPresetName", ""),
                )
            elif method == "device.listPresets":
                result = self.device.list_presets(params.get("refresh", False))
            elif method == "device.navigateBank":
                result = self.device.navigate_bank(
                    params.get("direction"),
                    params.get("expectedPresetName", ""),
                    params.get("expectedPosition"),
                )
            elif method == "device.recallPreset":
                result = self.device.recall_preset(
                    params.get("setlistKey"),
                    params.get("position"),
                    params.get("expectedPresetName", ""),
                    params.get("expectedPosition"),
                )
            elif method == "device.reloadPreset":
                result = self.device.reload_preset(
                    params.get("expectedPresetName", ""),
                    params.get("expectedPosition"),
                )
            elif method == "device.blockDetails":
                result = self.device.block_details(
                    params.get("row"),
                    params.get("column"),
                    params.get("expectedPresetName", ""),
                )
            elif method == "device.setParameter":
                result = self.device.set_parameter(
                    params.get("row"),
                    params.get("column"),
                    params.get("parameterIndex"),
                    params.get("value"),
                    params.get("expectedValue"),
                    params.get("expectedScene"),
                    params.get("expectedPresetName", ""),
                )
            elif method == "device.listPresetSlots":
                result = self.device.list_preset_slots()
            elif method == "device.savePresetAs":
                result = self.device.save_preset_as(
                    params.get("setlistKey"),
                    params.get("position"),
                    params.get("name"),
                    params.get("expectedPresetName", ""),
                    params.get("expectedPosition"),
                    params.get("confirmOverwrite", False),
                )
            elif method == "device.showTuner":
                result = self.device.show_tuner(params.get("shown", True))
            elif method == "device.showGigView":
                result = self.device.show_gig_view(params.get("shown", True))
            else:
                return self._error(request_id, -32601, f"Method not found: {method}")
            return {"jsonrpc": "2.0", "id": request_id, "result": result}
        except Exception as exc:
            # The public message is actionable but deliberately excludes tracebacks,
            # paths, serials, and other diagnostics that require explicit export.
            return self._error(request_id, -32010, str(exc))

    @staticmethod
    def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
