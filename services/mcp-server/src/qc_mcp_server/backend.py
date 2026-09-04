"""Composition modes for the MCP service."""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol

from qc_gateway_client import InProcessGatewayClient, StdioGatewayClient


class QcBackend(Protocol):
    def request(self, method: str, params: Mapping[str, Any] | None = None) -> Any: ...
    def close(self) -> None: ...


def repository_gateway_command() -> list[str] | None:
    """Find the development gateway without baking a repository path into releases."""
    current = Path(__file__).resolve()
    for parent in current.parents:
        candidate = parent / "services" / "device-gateway" / "main.py"
        if candidate.is_file():
            return [sys.executable, str(candidate), "--stdio"]
    return None


def gateway_backend(command: str | Sequence[str] | None = None) -> QcBackend:
    configured = os.environ.get("NDSP_QC_GATEWAY_COMMAND")
    selected = (
        StdioGatewayClient.from_command_line(command).command
        if isinstance(command, str)
        else list(command) if command else
        StdioGatewayClient.from_command_line(configured).command if configured else
        repository_gateway_command()
    )
    if not selected:
        raise RuntimeError(
            "Gateway mode requires --gateway-command or NDSP_QC_GATEWAY_COMMAND."
        )
    return StdioGatewayClient(selected)


def direct_backend() -> QcBackend:
    """Own USB in-process through the existing device adapter composition root."""
    try:
        from qc_device_gateway.service import GatewayService
    except ImportError as exc:
        raise RuntimeError(
            "Direct mode requires the device-gateway package and its hardware dependencies."
        ) from exc
    return InProcessGatewayClient(GatewayService())
