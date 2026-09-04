"""Import native 800x480 CorOS frames from Neural DSP's official manual.

The physical-device corpus remains the strongest reference. This second,
provenance-preserving corpus fills screens that are documented by Neural DSP
but are not yet safely reachable through the recovered remote-control API.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import struct
from urllib.request import Request, urlopen


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
MANUAL_URL = "https://neuraldsp.com/manual/quad-cortex"
USER_AGENT = "ndsp-qc-ui-corpus/1.0"

# Official alt text -> stable corpus id and deterministic shared-renderer state.
# The sole QC mini-specific 800x480 frame is retained for provenance but is not
# mapped to the first-generation Quad Cortex renderer.
RENDERER_STATES: dict[str, tuple[str, str, dict[str, str]]] = {
    "QC Tuner Menu 1": ("official-tuner", "tuner", {"tunerState": "official"}),
    "QC Tempo Menu 1": ("official-tempo", "tempo", {}),
    "QC Modes Config Menu 2": ("official-modes-configuration", "modes-official", {}),
    "QC Gig View PRESET": ("official-gig-view-preset", "gig-official-preset", {}),
    "QC Gig View SCENE": ("official-gig-view-scene", "gig-official-scene", {}),
    "QC Gig View STOMP": ("official-gig-view-stomp", "gig-official-stomp", {}),
    "QC Gig View HYBRID": ("official-gig-view-hybrid", "gig-official-hybrid", {}),
    "IO Settings Analog": ("official-io-settings-analog", "io-input", {}),
    "IO Settings USB": ("official-io-settings-usb", "io-usb", {}),
    "QC IO GLOBAL EQ 2": ("official-global-eq", "global-eq", {}),
    "QC 1A Brit 2203": ("official-grid-brit-2203", "grid-official-brit", {}),
    "QC Empty Slot Tap": ("official-empty-slot", "empty-slot", {}),
    "QC Virtual Device List Amp": ("official-device-browser-amp", "device-browser-amp-official", {}),
    "DV Presets Screen 1": ("official-device-presets", "device-presets-official", {}),
    "VD Presets Cotextual Options": ("official-device-preset-actions", "device-preset-actions-official", {}),
    "QC Exp Bypass Menu": ("official-expression-bypass", "expression-bypass", {}),
    "QC Looper X": ("official-looper", "looper-editor", {}),
    "QC Directory Presets": ("official-directory-presets", "directory-presets", {}),
    "QC Directory Fav Rec": ("official-directory-favorites", "directory-favorites", {}),
    "QC Directory Captures": ("official-directory-captures", "directory-captures", {}),
    "QC Directory IRs": ("official-directory-irs", "directory-irs", {}),
    "QC Plugin Presets New Logo": ("official-directory-plugin-presets", "directory-plugins", {}),
    "QC Search Results": ("official-directory-search-results", "directory-search-results", {}),
    "QC Nested Folders": ("official-directory-nested", "directory-nested", {}),
    "QC Upload Mode": ("official-directory-upload", "directory-cloud-upload", {}),
    "QC Capture Settings": ("official-capture-settings", "capture-calibration", {}),
    "QC Capture V1 Process": ("official-capture-process", "capture-progress", {}),
    "QC Capture V1 AB Test": ("official-capture-ab-test", "capture-result", {}),
    "QC Capture V1 Metadata": ("official-capture-metadata", "capture-save", {}),
    "QC Plugin Devices List": ("official-plugin-devices", "plugin-devices-official", {}),
    "QC Plugin Folders": ("official-plugin-folders", "plugin-folders", {}),
    "QC MIDI Settings": ("official-midi-settings", "settings-midi", {}),
    "QC MIDI Out": ("official-midi-out", "midi-out", {}),
    "QC Settings Account": ("official-settings-account", "settings-account", {}),
    "QC Settings System": ("official-settings-system", "settings-system", {}),
    "QC Settings Device 2": ("official-settings-device", "settings-device", {}),
}


class ImageCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.images: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "img":
            return
        values = dict(attrs)
        if values.get("src"):
            self.images.append((values.get("alt") or "", values["src"] or ""))


def fetch(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        return response.read()


def png_dimensions(payload: bytes) -> tuple[int, int]:
    if not payload.startswith(b"\x89PNG\r\n\x1a\n") or len(payload) < 24:
        raise ValueError("not a PNG")
    return struct.unpack(">II", payload[16:24])


def slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manual-url", default=MANUAL_URL)
    parser.add_argument(
        "--output",
        type=Path,
        default=REPOSITORY_ROOT / "references" / "qc-ui-official-manual" / "coros-4.1.0",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)

    collector = ImageCollector()
    collector.feed(fetch(args.manual_url).decode("utf-8", "replace"))
    unique = dict(collector.images)
    captures: list[dict[str, object]] = []
    seen_ids: set[str] = set()

    for label, url in unique.items():
        if not url.lower().endswith(".png"):
            continue
        payload = fetch(url)
        try:
            width, height = png_dimensions(payload)
        except ValueError:
            continue
        if (width, height) != (800, 480):
            continue
        mapped = RENDERER_STATES.get(label)
        capture_id = mapped[0] if mapped else f"official-{slug(label)}"
        if capture_id in seen_ids:
            raise RuntimeError(f"duplicate corpus id {capture_id!r}")
        seen_ids.add(capture_id)
        image_name = f"{capture_id}.png"
        (args.output / image_name).write_bytes(payload)
        entry: dict[str, object] = {
            "id": capture_id,
            "label": label,
            "image": image_name,
            "sourceUrl": url,
            "sha256": hashlib.sha256(payload).hexdigest(),
            "bytes": len(payload),
            "width": width,
            "height": height,
            "deviceVariant": "quad-cortex-mini" if "QCmini" in label else "quad-cortex",
        }
        if mapped:
            entry["renderer"] = {"screen": mapped[1], **mapped[2]}
        captures.append(entry)

    manifest = {
        "schemaVersion": 1,
        "corosVersion": "4.1.0",
        "sourceType": "official-manual",
        "sourceUrl": args.manual_url,
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "coordinateSpace": {"width": 800, "height": 480},
        "captures": captures,
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    mapped_count = sum("renderer" in capture for capture in captures)
    print(f"Imported {len(captures)} official 800x480 frames; {mapped_count} map to the shared renderer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
