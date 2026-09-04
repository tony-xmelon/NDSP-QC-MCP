"""JSON-RPC dispatch and lifecycle for the persistent QC session."""

from __future__ import annotations

from typing import Any

from .device import PyQuadCortexDevice
from .generated_gateway_dispatch import (
    GATEWAY_API_VERSION,
    GATEWAY_CAPABILITIES,
    GATEWAY_METHODS,
    dispatch_device_method,
)


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
                    "gatewayApiVersion": GATEWAY_API_VERSION,
                    "capabilities": list(GATEWAY_CAPABILITIES),
                    "message": "Gateway active; guarded live controls plus explicitly confirmed preset Save As and Rename are available; other persistent writes remain locked.",
                }
            elif isinstance(method, str) and method in GATEWAY_METHODS:
                result = dispatch_device_method(self.device, method, params)
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
