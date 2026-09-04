"""Measure reconstructed screens against a native-size CorOS reference corpus."""

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
    parser.add_argument("--corpus", type=Path, help="Corpus directory; defaults to the physical-device corpus")
    parser.add_argument("--renderer", type=Path, required=True, help="Directory of <capture-id>.png renders")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--require-all", action="store_true")
    parser.add_argument("--mapped-only", action="store_true", help="Compare only manifest entries with renderer mappings")
    args = parser.parse_args()

    corpus = args.corpus or REPOSITORY_ROOT / "references" / "qc-ui-corpus" / f"coros-{args.coros}"
    manifest = json.loads((corpus / "manifest.json").read_text(encoding="utf-8"))
    args.output.mkdir(parents=True, exist_ok=True)
    results: list[dict[str, object]] = []
    missing: list[str] = []

    entries = [entry for entry in manifest["captures"] if not args.mapped_only or entry.get("renderer")]
    for entry in entries:
        capture_id = entry["id"]
        renderer_path = args.renderer / f"{capture_id}.png"
        if not renderer_path.is_file():
            missing.append(capture_id)
            continue
        reference = normalize(Image.open(corpus / entry["image"]), (800, 480))
        rendered = Image.open(renderer_path).convert("RGB")
        original_size = rendered.size
        rendered = normalize(rendered, (800, 480))
        measured = metrics(reference, rendered)
        result = {"id": capture_id, "renderWidth": original_size[0], "renderHeight": original_size[1], **measured}
        results.append(result)
        screen_output = args.output / capture_id
        screen_output.mkdir(exist_ok=True)
        Image.blend(reference, rendered, 0.5).save(screen_output / "overlay.png")
        ImageChops.difference(reference, rendered).save(screen_output / "difference.png")
        edge_overlay(reference, rendered).save(screen_output / "edges.png")
        (screen_output / "metrics.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")

    aggregate = {
        "coros": args.coros,
        "measured": len(results),
        "corpus": len(entries),
        "missing": missing,
        "meanMae": round(sum(float(item["mae"]) for item in results) / len(results), 4) if results else None,
        "meanEdgeF1_2px": round(sum(float(item["edge_f1_2px"]) for item in results) / len(results), 4) if results else None,
        "screens": results,
    }
    (args.output / "summary.json").write_text(json.dumps(aggregate, indent=2) + "\n", encoding="utf-8")
    rows = [
        f"# CorOS {args.coros} visual comparison",
        "",
        f"Measured {len(results)}/{len(entries)} corpus states. Mean MAE: {aggregate['meanMae']}; mean edge F1 (2px): {aggregate['meanEdgeF1_2px']}.",
        "",
        "| Screen | Render | MAE | Edge F1 (2px) |",
        "| --- | ---: | ---: | ---: |",
    ]
    rows.extend(f"| `{item['id']}` | {item['renderWidth']}x{item['renderHeight']} | {item['mae']:.4f} | {item['edge_f1_2px']:.4f} |" for item in results)
    if missing:
        rows.extend(["", "Missing renders: " + ", ".join(f"`{item}`" for item in missing)])
    (args.output / "summary.md").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in aggregate.items() if key != "screens"}, indent=2))
    return int(args.require_all and bool(missing))


if __name__ == "__main__":
    raise SystemExit(main())
