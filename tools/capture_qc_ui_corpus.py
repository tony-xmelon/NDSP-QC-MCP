"""Capture a reproducible visual corpus from a connected Quad Cortex.

The tool intentionally exposes only reversible display navigation plus PNG/tree
capture. It does not edit preset data. Commands are entered one per line:

    capture grid-base Base Grid
    tap 669 25
    wait 0.4
    capture grid-scene-menu Scene selector
    gig on
    capture gig-view Gig View
    gig off
    quit
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import struct
import sys
import time


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
GATEWAY_SOURCE = REPOSITORY_ROOT / "services" / "device-gateway" / "src"
sys.path.insert(0, str(GATEWAY_SOURCE))

import pyquadcortex  # noqa: E402

from qc_device_gateway.remote_control import (  # noqa: E402
    capture_graphics_tree,
    capture_screen,
    capture_settled_screen,
    hold_screen,
    install_remote_control_compat,
    swipe_screen,
    tap_screen,
    wake_remote_control,
)
from qc_device_gateway.device import send_qc_midi_cc  # noqa: E402


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def png_dimensions(payload: bytes) -> tuple[int, int]:
    if not payload.startswith(b"\x89PNG\r\n\x1a\n") or len(payload) < 24:
        raise ValueError("capture was not a valid PNG")
    return struct.unpack(">II", payload[16:24])


def classify_tree(tree: str) -> str:
    # Overlays and editors retain Grid in their backing view hierarchy, so the
    # most-specific screens must be checked before the Grid fallback.
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
        # CorOS exposes the same routing hierarchy for both editors, but the
        # physical Mixer has six parameter controls while the Splitter has seven.
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


def write_manifest(path: Path, manifest: dict[str, object]) -> None:
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--coros", required=True, help="CorOS version, for example 4.1.0")
    parser.add_argument(
        "--output",
        type=Path,
        default=REPOSITORY_ROOT / "references" / "qc-ui-corpus",
    )
    parser.add_argument(
        "--allow-preset-change",
        action="store_true",
        help="Disable the default guard that detects touchscreen navigation leaving the startup preset.",
    )
    args = parser.parse_args()

    corpus = args.output / f"coros-{args.coros}"
    corpus.mkdir(parents=True, exist_ok=True)
    manifest_path = corpus / "manifest.json"
    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "corosVersion": args.coros,
        "coordinateSpace": {"width": 800, "height": 480},
        "createdAt": utc_now(),
        "captures": [],
    }
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    install_remote_control_compat()
    qc = pyquadcortex.connect()
    actions: list[dict[str, object]] = []
    try:
        wake_remote_control(qc)  # Prime dormant CorOS sessions and restore Grid.
        time.sleep(0.3)

        def read_preset_state() -> tuple[str, bool]:
            last_error: Exception | None = None
            for attempt in range(3):
                try:
                    return str(qc.read_current_preset().name), bool(qc.preset_dirty())
                except Exception as error:
                    last_error = error
                    time.sleep(0.4 * (attempt + 1))
            raise RuntimeError("could not read a stable preset identity after three attempts") from last_error

        baseline_preset_name, baseline_dirty = read_preset_state()

        def guard_preset() -> None:
            if args.allow_preset_change:
                return
            current_name, current_dirty = read_preset_state()
            if current_name != baseline_preset_name:
                raise RuntimeError(
                    "SAFETY: touchscreen navigation changed the active preset from "
                    f"{baseline_preset_name!r} to {current_name!r}; restore it before continuing."
                )
            if current_dirty != baseline_dirty:
                raise RuntimeError(
                    "SAFETY: touchscreen navigation changed the preset dirty state; "
                    "restore the startup preset before continuing."
                )

        print(
            f"Connected on preset {baseline_preset_name!r}. Enter 'help' for commands.",
            flush=True,
        )
        while True:
            print("corpus> ", end="", flush=True)
            line = sys.stdin.readline()
            if not line:
                break
            try:
                parts = shlex.split(line)
                if not parts:
                    continue
                command, *values = parts
                if command in {"quit", "exit"}:
                    break
                if command == "help":
                    print("capture SLUG [LABEL] | capture-now SLUG [LABEL] | tap X Y | hold X Y [SECONDS] | swipe X1 Y1 X2 Y2 [SECONDS] | midi CC [VALUE] | wait SECONDS | gig on|off | scene 0..7 | tree | quit", flush=True)
                elif command == "tap" and len(values) == 2:
                    x, y = int(values[0]), int(values[1])
                    tap_screen(qc, x, y)
                    actions.append({"type": "tap", "x": x, "y": y})
                    guard_preset()
                    print(f"Tapped {x},{y}", flush=True)
                elif command == "wait" and len(values) == 1:
                    seconds = float(values[0])
                    time.sleep(seconds)
                    actions.append({"type": "wait", "seconds": seconds})
                elif command == "swipe" and len(values) in (4, 5):
                    from_x, from_y, to_x, to_y = map(int, values[:4])
                    duration = float(values[4]) if len(values) == 5 else 0.35
                    swipe_screen(qc, from_x, from_y, to_x, to_y, duration)
                    actions.append({"type": "swipe", "from": [from_x, from_y], "to": [to_x, to_y], "duration": duration})
                    guard_preset()
                    print(f"Swiped {from_x},{from_y} to {to_x},{to_y}", flush=True)
                elif command == "hold" and len(values) in (2, 3):
                    x, y = map(int, values[:2])
                    duration = float(values[2]) if len(values) == 3 else 0.8
                    hold_screen(qc, x, y, duration)
                    actions.append({"type": "hold", "x": x, "y": y, "duration": duration})
                    guard_preset()
                    print(f"Held {x},{y} for {duration:.2f}s", flush=True)
                elif command == "midi" and len(values) in (1, 2):
                    controller = int(values[0])
                    value = int(values[1]) if len(values) == 2 else 127
                    if not 0 <= controller <= 127 or not 0 <= value <= 127:
                        raise ValueError("MIDI controller and value must be 0 through 127")
                    endpoint = send_qc_midi_cc(controller, value)
                    actions.append({"type": "midiControlChange", "controller": controller, "value": value})
                    print(f"Sent MIDI CC {controller} value {value} through {endpoint}", flush=True)
                elif command == "gig" and values in (["on"], ["off"]):
                    shown = values[0] == "on"
                    qc.set_gig_view(shown)
                    actions.append({"type": "showGigView", "shown": shown})
                elif command == "scene" and len(values) == 1:
                    scene = int(values[0])
                    if not 0 <= scene < 8:
                        raise ValueError("scene must be 0 through 7")
                    qc.switch_scene(scene)
                    actions.append({"type": "selectScene", "scene": scene})
                elif command == "tree" and not values:
                    print(capture_graphics_tree(qc), flush=True)
                elif command in {"capture", "capture-now"} and values:
                    guard_preset()
                    slug = values[0]
                    if not slug.replace("-", "").replace("_", "").isalnum():
                        raise ValueError("slug may contain only letters, numbers, dashes, and underscores")
                    label = " ".join(values[1:]) or slug.replace("-", " ").title()
                    if command == "capture":
                        time.sleep(0.35)
                    png = capture_screen(qc) if command == "capture-now" else capture_settled_screen(qc)
                    tree = capture_graphics_tree(qc)
                    width, height = png_dimensions(png)
                    image_name = f"{slug}.png"
                    tree_name = f"{slug}.tree.txt"
                    (corpus / image_name).write_bytes(png)
                    (corpus / tree_name).write_text(tree, encoding="utf-8")
                    entry = {
                        "id": slug,
                        "label": label,
                        "screen": classify_tree(tree),
                        "image": image_name,
                        "graphicsTree": tree_name,
                        "sha256": hashlib.sha256(png).hexdigest(),
                        "bytes": len(png),
                        "width": width,
                        "height": height,
                        "capturedAt": utc_now(),
                        "actions": list(actions),
                    }
                    captures = manifest.setdefault("captures", [])
                    assert isinstance(captures, list)
                    captures[:] = [item for item in captures if item.get("id") != slug]
                    captures.append(entry)
                    write_manifest(manifest_path, manifest)
                    actions.clear()
                    print(f"Captured {slug}: {width}x{height}, {len(png)} bytes, {entry['screen']}", flush=True)
                else:
                    print("Unknown or malformed command; enter 'help'.", flush=True)
            except Exception as error:  # Keep the hardware session for recovery.
                print(f"ERROR: {error}", flush=True)
    finally:
        qc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
