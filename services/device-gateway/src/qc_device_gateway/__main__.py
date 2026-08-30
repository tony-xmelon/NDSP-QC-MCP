"""Run the gateway over its private framed stdin/stdout transport."""

from __future__ import annotations

import argparse
import sys

from .framing import FramingError, read_frame, write_frame
from .service import GatewayService


def serve() -> int:
    service = GatewayService()
    try:
        while True:
            try:
                request = read_frame(sys.stdin.buffer)
            except FramingError as exc:
                write_frame(sys.stdout.buffer, {
                    "jsonrpc": "2.0", "id": None,
                    "error": {"code": -32700, "message": str(exc)},
                })
                continue
            if request is None:
                return 0
            write_frame(sys.stdout.buffer, service.handle(request))
    finally:
        service.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="QC Voice Control device gateway")
    parser.add_argument("--stdio", action="store_true", help="serve framed JSON-RPC on stdin/stdout")
    args = parser.parse_args(argv)
    if not args.stdio:
        parser.error("the development gateway currently requires --stdio")
    return serve()


if __name__ == "__main__":
    raise SystemExit(main())
