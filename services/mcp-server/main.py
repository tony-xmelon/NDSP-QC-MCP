"""Repository development entry point."""

from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).parent / "src"))
sys.path.insert(0, str(root / "packages" / "python" / "qc-gateway-client" / "src"))
sys.path.insert(0, str(root / "services" / "device-gateway" / "src"))

from qc_mcp_server.__main__ import main


if __name__ == "__main__":
    raise SystemExit(main())
