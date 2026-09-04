"""Capture a serial-number-free, exhaustive ModelRepo scale baseline from a QC."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).parents[2]
sys.path.insert(0, str(ROOT / "services" / "device-gateway" / "src"))

from qc_device_gateway.device import PyQuadCortexDevice


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    device = PyQuadCortexDevice()
    try:
        device.reconnect()
        catalog = device._ensure_catalog()
        models = []
        for model in sorted(catalog, key=lambda item: int(item.id)):
            parameters = []
            for parameter in model.parameters:
                metadata = device._parameter_scales[(int(model.id), int(parameter.index))]
                parameters.append({
                    "index": int(parameter.index),
                    "name": parameter.name,
                    "type": parameter.type,
                    **{key: value for key, value in metadata.items() if key not in ("hidden", "source")},
                })
            models.append({
                "id": int(model.id), "name": model.name, "category": model.category,
                "hidden": bool(model.hidden or model.internal or model.category_hidden),
                "parameters": parameters,
            })
        document = {
            "source": "Quad Cortex ModelRepo XML; no device identity retained",
            "audit": device._parameter_scale_audit,
            "models": models,
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({"output": str(args.output.resolve()), **device._parameter_scale_audit}))
        return 0
    finally:
        device.close()


if __name__ == "__main__":
    raise SystemExit(main())
