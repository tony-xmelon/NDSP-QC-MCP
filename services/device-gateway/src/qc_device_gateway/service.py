"""JSON-RPC dispatch and lifecycle for the persistent QC session."""

from __future__ import annotations

from typing import Any

from .device import PyQuadCortexDevice
from .generated_gateway_dispatch import (
    GATEWAY_API_VERSION,
    GATEWAY_CAPABILITIES,
    GATEWAY_METHODS,
    GATEWAY_RESULT_KINDS,
    dispatch_device_method,
    validate_gateway_params,
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
            or request_id < 1
            or not set(request).issubset({"jsonrpc", "id", "method", "params"})
        ):
            return self._error(request_id, -32600, "Invalid JSON-RPC request")
        method = request.get("method")
        params = request.get("params", {})
        if not isinstance(params, dict):
            return self._error(request_id, -32602, "Method params must be an object")
        try:
            if not isinstance(method, str) or method not in GATEWAY_METHODS:
                return self._error(request_id, -32601, f"Method not found: {method}")
            try:
                validate_gateway_params(method, params)
            except ValueError as exc:
                return self._error(request_id, -32602, str(exc))
            if method == "system.status":
                result = {
                    "platform": "Python device gateway",
                    "gatewayAvailable": True,
                    "gatewayApiVersion": GATEWAY_API_VERSION,
                    "capabilities": list(GATEWAY_CAPABILITIES),
                    "message": "Gateway active; the complete versioned command surface is available with expected-state guards and explicit confirmation for persistent or risky operations.",
                }
            else:
                result = dispatch_device_method(self.device, method, params)
            return {"jsonrpc": "2.0", "id": request_id, "result": self._normalize_result(method, result)}
        except Exception as exc:
            # The public message is actionable but deliberately excludes tracebacks,
            # paths, serials, and other diagnostics that require explicit export.
            raw_code = getattr(exc, "code", -32010)
            code = raw_code if isinstance(raw_code, int) and not isinstance(raw_code, bool) else -32010
            raw_retryable = getattr(exc, "retryable", False)
            return self._error(
                request_id, code, str(exc),
                retryable=raw_retryable if isinstance(raw_retryable, bool) else False,
            )

    @staticmethod
    def _normalize_result(method: str, result: Any) -> Any:
        kind = GATEWAY_RESULT_KINDS[method]
        if not isinstance(result, dict):
            raise TypeError(f"{method} returned a malformed {kind} result")
        if kind == "PresetSnapshot" and (
            not isinstance(result.get("presetName"), str) or not isinstance(result.get("blocks"), list)
        ):
            raise TypeError(f"{method} returned a malformed PresetSnapshot result")
        if kind == "DeviceActionResult":
            normalized = dict(result)
            if not any(key in normalized for key in ("accepted", "verified", "verification")):
                verified = isinstance(normalized.get("snapshot"), dict) or isinstance(normalized.get("block"), dict)
                normalized.update({
                    "accepted": True,
                    "verified": verified,
                    "verification": "authoritative_readback" if verified else "accepted_unverified",
                })
            return normalized
        return result

    @staticmethod
    def _error(request_id: Any, code: int, message: str, *, retryable: bool = False) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {
            "code": code, "message": message, "data": {"retryable": retryable},
        }}
