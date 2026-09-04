"""CLI entry point for the standalone MCP server."""

from __future__ import annotations

import argparse
from typing import Literal, cast

from .backend import direct_backend, gateway_backend
from .server import create_mcp


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Standalone NDSP Quad Cortex MCP server")
    parser.add_argument("--mode", choices=("gateway", "direct"), default="gateway")
    parser.add_argument("--gateway-command", help="gateway executable command for gateway mode")
    parser.add_argument("--transport", choices=("stdio", "streamable-http"), default="stdio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args(argv)

    backend = direct_backend() if args.mode == "direct" else gateway_backend(args.gateway_command)
    mcp = create_mcp(backend)
    try:
        transport = cast(Literal["stdio", "streamable-http"], args.transport)
        if transport == "stdio":
            mcp.run(transport="stdio")
        else:
            mcp.run(transport="streamable-http", host=args.host, port=args.port)
    finally:
        backend.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
