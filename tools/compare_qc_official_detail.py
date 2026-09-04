"""Compare an app crop with a transparent raster of an official QC SVG detail."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageChops


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "tools" / "visual-regression"))

from qc_compare import difference_image, edge_overlay, metrics  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--detail", type=Path, required=True, help="Transparent official-detail PNG")
    parser.add_argument("--renderer", type=Path, required=True, help="Rendered 800x480 host capture")
    parser.add_argument("--crop", nargs=4, type=int, required=True, metavar=("X", "Y", "W", "H"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", default="official-detail")
    args = parser.parse_args()

    reference = Image.open(args.detail).convert("RGBA")
    x, y, width, height = args.crop
    rendered = Image.open(args.renderer).convert("RGB").crop((x, y, x + width, y + height))
    if reference.size != rendered.size:
        raise SystemExit(f"detail is {reference.size}, renderer crop is {rendered.size}")

    alpha = np.asarray(reference.getchannel("A"), dtype=np.float32) / 255.0
    if not np.any(alpha):
        raise SystemExit("detail has no visible pixels")
    reference_rgb = np.asarray(reference.convert("RGB"), dtype=np.float32)
    rendered_rgb = np.asarray(rendered, dtype=np.float32)
    weighted_error = np.abs(reference_rgb - rendered_rgb) * alpha[..., None]
    masked_mae = float(weighted_error.sum() / (alpha.sum() * 3 * 255.0))

    # Transparent pixels are outside the official fragment's evidence scope. Copying
    # the renderer through those pixels makes edge scoring operate on the documented
    # controls without inventing a background for the manual SVG.
    composited = rendered.copy()
    composited.paste(reference.convert("RGB"), mask=reference.getchannel("A"))
    structural = metrics(composited, rendered)
    result = {
        "label": args.label,
        "detail": str(args.detail),
        "renderer": str(args.renderer),
        "crop": [x, y, width, height],
        "visiblePixelEquivalent": round(float(alpha.sum()), 2),
        "maskedMae": round(masked_mae, 4),
        "colorMatchPercent": round((1.0 - masked_mae) * 100.0, 2),
        "structuralMatchPercent": round(structural["edge_f1_2px"] * 100.0, 2),
    }

    args.output.mkdir(parents=True, exist_ok=True)
    reference.save(args.output / "reference.png")
    rendered.save(args.output / "renderer.png")
    Image.blend(composited, rendered, 0.5).save(args.output / "overlay.png")
    ImageChops.difference(composited, rendered).save(args.output / "difference-raw.png")
    difference_image(composited, rendered).save(args.output / "difference.png")
    edge_overlay(composited, rendered).save(args.output / "edges.png")
    (args.output / "metrics.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
