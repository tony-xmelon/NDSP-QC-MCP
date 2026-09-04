"""Validate and optionally normalize a captured Quad Cortex UI corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


def png_dimensions(payload: bytes) -> tuple[int, int]:
    if not payload.startswith(b"\x89PNG\r\n\x1a\n") or len(payload) < 24:
        raise ValueError("not a PNG")
    return struct.unpack(">II", payload[16:24])


def classify_tree(tree: str) -> str:
    if "zenUI::Tuner" in tree:
        return "tuner"
    if "zenUI::MetronomeEditor" in tree:
        return "tempo"
    if "zenUI::HybridModeConfigDialog" in tree:
        return "modes-configuration"
    if "zenUI::PresetSaveDialog" in tree and "zenUI::KeyboardTextInput" in tree:
        return "preset-name-editor"
    if "zenUI::MidiMatrixDialog" in tree:
        return "midi-out"
    if "zenUI::CopySceneDialog" in tree:
        return "scene-destination"
    if "zenUI::DirectoryDialog" in tree and "Save to..." in tree:
        return "save-as-editor"
    if "zenUI::GigView" in tree:
        return "gig-view"
    if "zenUI::Directory" in tree:
        return "directory"
    if "zenUI::SplitControlPointGrid" in tree and "zenUI::ContainerWithSplitter" in tree and "zenUI::ParameterControl" in tree:
        return "mixer-editor" if tree.count("zenUI::ParameterControl") == 6 else "splitter-editor"
    if "zenUI::ParameterEditor" in tree or "Parameter Editor" in tree:
        return "parameter-editor"
    if "Create New" in tree and "Preset MIDI Out" in tree:
        return "grid-context-menu"
    if "Default scene" in tree and "Scene H" in tree:
        return "scene-selector"
    if "Not In Use" in tree:
        return "route-selector"
    if "zenUI::ModelMenu" in tree:
        return "device-browser"
    browser_categories = ("Neural Capture", "Overdrive", "Reverb", "Pitch", "Utility")
    if sum(label in tree for label in browser_categories) >= 3:
        return "device-browser"
    if "zenUI::Grid" in tree:
        return "grid"
    return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    parser.add_argument("--rewrite", action="store_true", help="Normalize derived manifest fields")
    args = parser.parse_args()
    manifest_path = args.corpus / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    failures: list[str] = []
    seen: set[str] = set()

    for capture in manifest.get("captures", []):
        capture_id = capture["id"]
        if capture_id in seen:
            failures.append(f"{capture_id}: duplicate id")
        seen.add(capture_id)
        image_path = args.corpus / capture["image"]
        tree_name = capture.get("graphicsTree")
        tree_path = args.corpus / tree_name if tree_name else None
        if not image_path.is_file() or (tree_path is not None and not tree_path.is_file()):
            failures.append(f"{capture_id}: missing image or graphics tree")
            continue
        payload = image_path.read_bytes()
        try:
            width, height = png_dimensions(payload)
        except ValueError as error:
            failures.append(f"{capture_id}: {error}")
            continue
        derived = {
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "width": width,
            "height": height,
        }
        if tree_path is not None:
            derived["screen"] = classify_tree(tree_path.read_text(encoding="utf-8"))
        if width != 800 or height != 480:
            failures.append(f"{capture_id}: expected 800x480, got {width}x{height}")
        for field, value in derived.items():
            if args.rewrite:
                capture[field] = value
            elif capture.get(field) != value:
                failures.append(f"{capture_id}: stale {field} ({capture.get(field)!r} != {value!r})")

    if args.rewrite:
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    if failures:
        for failure in failures:
            print(f"FAIL {failure}")
        return 1
    print(f"PASS {len(seen)} captures; all PNGs are 800x480 and manifest metadata matches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
