"""Development entry point for the QC device gateway."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "src"))

from qc_device_gateway.__main__ import main


if __name__ == "__main__":
    raise SystemExit(main())
