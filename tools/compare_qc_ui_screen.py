"""Compare one reconstructed 800x480 screen with the versioned QC corpus."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from PIL import Image, ImageChops


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPOSITORY_ROOT / "tools" / "visual-regression"))

from qc_compare import edge_overlay, metrics, normalize  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--coros", required=True)
    parser.add_argument("--capture", required=True, help="Corpus capture id")
    parser.add_argument("--renderer", type=Path, required=True, help="Rendered PNG")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--crop", nargs=4, type=int, metavar=("X", "Y", "W", "H"))
    parser.add_argument("--max-mae", type=float)
    args = parser.parse_args()

    corpus = REPOSITORY_ROOT / "references" / "qc-ui-corpus" / f"coros-{args.coros}"
    manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
    entry = next((item for item in manifest["captures"] if item["id"] == args.capture), None)
    if entry is None:
        raise SystemExit(f"Unknown capture id: {args.capture}")

    reference = normalize(Image.open(corpus / entry["image"]), (800, 480))
    rendered = Image.open(args.renderer).convert("RGB")
    if args.crop:
        x, y, width, height = args.crop
        rendered = rendered.crop((x, y, x + width, y + height))
    rendered = normalize(rendered, (800, 480))
    result = {"coros": args.coros, "capture": args.capture, **metrics(reference, rendered)}

    args.output.mkdir(parents=True, exist_ok=True)
    Image.blend(reference, rendered, .5).save(args.output / "overlay.png")
    ImageChops.difference(reference, rendered).save(args.output / "difference.png")
    edge_overlay(reference, rendered).save(args.output / "edges.png")
    (args.output / "metrics.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return int(args.max_mae is not None and result["mae"] > args.max_mae)


if __name__ == "__main__":
    raise SystemExit(main())
