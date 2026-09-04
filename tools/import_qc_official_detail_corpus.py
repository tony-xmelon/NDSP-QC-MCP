"""Import official CorOS SVG details without pretending they are full frames.

The Quad Cortex manual mixes native 800x480 screenshots with smaller SVG
interaction diagrams.  The PNG corpus benchmarks complete screens; this corpus
preserves the SVGs as authoritative evidence for individual controls, gestures,
editor fragments, and hardware connection diagrams.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MANUAL_URL = "https://neuraldsp.com/manual/quad-cortex"
USER_AGENT = "ndsp-qc-ui-detail-corpus/1.0"

# label -> (stable id, evidence scope, canonical screen/state ids)
DETAILS: dict[str, tuple[str, str, list[str]]] = {
    "QC Power On 2": ("official-detail-power-on", "hardware-control", ["GL-01"]),
    "QC Power Off": ("official-detail-power-off", "hardware-control", ["GL-02"]),
    "Power Locking Overlay": ("official-detail-power-overlay", "overlay-fragment", ["GL-03"]),
    "QC Grid Scene Selector": ("official-detail-grid-scene-selector", "full-frame", ["GL-07"]),
    "QC CPU Mon Access": ("official-detail-cpu-monitor-access", "navigation-control", ["GL-23"]),
    "QC IO Settings Access": ("official-detail-io-settings-access", "hardware-control", ["IO-01"]),
    "QC Block Param Editor Action": ("official-detail-parameter-editor-open", "interaction-sequence", ["ED-02"]),
    "QC Param Editor Cycle": ("official-detail-parameter-editor-cycle", "hardware-control", ["ED-02"]),
    "QC Param Editor Encoders": ("official-detail-parameter-editor-encoders", "hardware-control", ["ED-02"]),
    "QC Stomp Assignment 3": ("official-detail-stomp-assignment", "editor-fragment", ["ED-09"]),
    "QC Scene Assigment": ("official-detail-scene-assignment", "editor-fragment", ["ED-10"]),
    "QC Exp Pedal Assignment Action": ("official-detail-expression-assignment", "interaction-sequence", ["ED-11"]),
    "QC Directory Categories": ("official-detail-directory-categories", "navigation-control", ["DR-01"]),
    "QC Search": ("official-detail-directory-search", "navigation-control", ["DR-07"]),
    "QC Sorting": ("official-detail-directory-sort", "navigation-control", ["DR-09"]),
    "QC Funnel": ("official-detail-directory-filter", "navigation-control", ["DR-10"]),
    "QC Multiselect": ("official-detail-directory-multiselect", "navigation-control", ["DR-11"]),
    "QC Multiselect Copy": ("official-detail-directory-copy", "navigation-control", ["DR-12"]),
    "QC New Folder": ("official-detail-directory-new-folder", "menu-item", ["DR-14"]),
    "QC Capture Intro": ("official-detail-capture-intro", "hardware-diagram", ["NC-01"]),
    "QC Capture V1 Access": ("official-detail-capture-access", "interaction-sequence", ["NC-01"]),
    "QC Capture V1 Step 01": ("official-detail-capture-routing-input-1", "hardware-diagram", ["NC-03"]),
    "QC Capture V1 Step 02b": ("official-detail-capture-routing-input-2", "hardware-diagram", ["NC-03"]),
    "QC Capture V1 Step 03": ("official-detail-capture-routing-output", "hardware-diagram", ["NC-03"]),
    "QC Capture V1 Step 04": ("official-detail-capture-routing-return", "hardware-diagram", ["NC-03"]),
    "QC Plugin Refresh": ("official-detail-plugin-refresh", "navigation-control", ["DB-08"]),
    "QC Recovery Access": ("official-detail-recovery-access", "hardware-control", ["RC-01"]),
}


class ImageCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.images: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "img":
            return
        values = dict(attrs)
        label = values.get("alt") or ""
        source = values.get("src") or ""
        if label and source:
            self.images.setdefault(label, source)


def fetch(url: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(5):
        try:
            request = Request(url, headers={"User-Agent": USER_AGENT, "Connection": "close"})
            with urlopen(request, timeout=30) as response:
                return response.read()
        except Exception as error:  # transient Contentful resets are common during batch imports
            last_error = error
            time.sleep(0.75 * (attempt + 1))
    raise RuntimeError(f"could not fetch {url}") from last_error


def svg_geometry(payload: bytes) -> tuple[int, int, str]:
    head = payload[:2000].decode("utf-8", "replace")
    tag = re.search(r"<svg\b[^>]*>", head, re.IGNORECASE)
    if not tag:
        raise ValueError("not an SVG")
    width = re.search(r'\bwidth="(\d+)"', tag.group(0))
    height = re.search(r'\bheight="(\d+)"', tag.group(0))
    view_box = re.search(r'\bviewBox="([^"]+)"', tag.group(0))
    if not width or not height or not view_box:
        raise ValueError("SVG has no integer width, height, or viewBox")
    return int(width.group(1)), int(height.group(1)), view_box.group(1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manual-url", default=MANUAL_URL)
    parser.add_argument(
        "--output",
        type=Path,
        default=REPOSITORY_ROOT / "references" / "qc-ui-official-details" / "coros-4.1.0",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    manifest_path = args.output / "manifest.json"
    previous_assets: dict[str, dict[str, object]] = {}
    if manifest_path.exists():
        previous_manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        previous_assets = {asset["label"]: asset for asset in previous_manifest.get("assets", [])}

    collector = ImageCollector()
    collector.feed(fetch(args.manual_url).decode("utf-8", "replace"))
    missing = sorted(set(DETAILS) - set(collector.images))
    if missing:
        raise RuntimeError(f"official manual no longer exposes expected assets: {missing}")

    assets: list[dict[str, object]] = []
    for label, (asset_id, scope, states) in DETAILS.items():
        source_url = collector.images[label]
        filename = f"{asset_id}.svg"
        output_path = args.output / filename
        previous = previous_assets.get(label)
        payload: bytes
        if (
            previous
            and previous.get("sourceUrl") == source_url
            and output_path.exists()
            and hashlib.sha256(output_path.read_bytes()).hexdigest() == previous.get("sha256")
        ):
            payload = output_path.read_bytes()
        else:
            payload = fetch(source_url)
        width, height, view_box = svg_geometry(payload)
        output_path.write_bytes(payload)
        assets.append({
            "id": asset_id,
            "label": label,
            "image": filename,
            "sourceUrl": source_url,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "width": width,
            "height": height,
            "viewBox": view_box,
            "evidenceScope": scope,
            "states": states,
        })
        time.sleep(0.15)

    manifest = {
        "schemaVersion": 1,
        "corosVersion": "4.1.0",
        "sourceType": "official-manual-detail",
        "sourceUrl": args.manual_url,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "assets": assets,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(assets)} official SVG details covering {len({state for asset in assets for state in asset['states']})} canonical states")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
