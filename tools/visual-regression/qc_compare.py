"""Generate normalized visual comparisons for the Quad Cortex renderer.

Reference images are intentionally supplied at runtime and are never stored in
the repository or shipped with the application.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageEnhance, ImageFilter, ImageOps


PANEL_SIZE = (1096, 718)
GRID_SIZE = (800, 480)

# Normalized measurements from Neural DSP's official qc-overview-001.svg.
SVG_LANDMARKS = {
    "screen": {"cx": 0.5, "cy": 0.3213, "w": 0.5396, "h": 0.4649},
    "volume": {"cx": 0.1034, "cy": 0.2947, "w": 0.1121, "h": 0.1711},
    "nav": {"cx": 0.9414, "cy": 0.3157, "w": 0.0417, "h": 0.0637},
    "switch_x": [0.0586, 0.2793, 0.5, 0.7207, 0.9414],
    "top_led_y": 0.6349,
    "top_switch_y": 0.6974,
    "bottom_led_y": 0.8759,
    "bottom_switch_y": 0.9385,
}


def normalize_photo(path: Path) -> Image.Image:
    """Rectify the near-top-down retail photo to the documented panel ratio."""
    image = Image.open(path).convert("RGB")
    # Source corners were measured on the 1988 × 1326 Tonefest top-down image.
    quad = (276, 145, 285, 1014, 1594, 1014, 1618, 145)
    return image.transform(
        PANEL_SIZE,
        Image.Transform.QUAD,
        quad,
        resample=Image.Resampling.BICUBIC,
    )


def normalize(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    # Captures are already cropped to their intended bounds. Resizing preserves
    # the complete reference instead of silently trimming it to the target ratio.
    return image.convert("RGB").resize(size, Image.Resampling.LANCZOS)


def normalize_grid_reference(path: Path) -> Image.Image:
    """Extract the 5:3 screen capture from the manual's presentation canvas."""
    image = Image.open(path).convert("RGB")
    if image.size == GRID_SIZE:
        # The official 800 × 480 asset presents the 5:3 device capture centered
        # inside a black canvas. These bounds isolate the actual screen pixels.
        image = image.crop((164, 80, 694, 400))
    return normalize(image, GRID_SIZE)


def edge_mask(image: Image.Image) -> np.ndarray:
    gray = ImageOps.autocontrast(image.convert("L"))
    edges = np.asarray(gray.filter(ImageFilter.FIND_EDGES), dtype=np.float32)
    threshold = max(24.0, float(np.percentile(edges, 88)))
    return edges >= threshold


def edge_overlay(reference: Image.Image, renderer: Image.Image) -> Image.Image:
    reference_edges = edge_mask(reference)
    renderer_edges = edge_mask(renderer)
    canvas = np.full((*reference_edges.shape, 3), 20, dtype=np.uint8)
    canvas[reference_edges] = (255, 74, 126)
    canvas[renderer_edges] = (55, 218, 255)
    canvas[reference_edges & renderer_edges] = (245, 245, 245)
    return Image.fromarray(canvas, "RGB")


def difference_image(reference: Image.Image, renderer: Image.Image) -> Image.Image:
    difference = ImageChops.difference(reference, renderer)
    difference = ImageEnhance.Contrast(difference).enhance(2.2)
    luminance = np.asarray(difference.convert("L"), dtype=np.float32) / 255.0
    heat = np.zeros((*luminance.shape, 3), dtype=np.uint8)
    heat[..., 0] = np.clip(luminance * 420, 0, 255)
    heat[..., 1] = np.clip((luminance - 0.18) * 330, 0, 220)
    heat[..., 2] = np.clip((0.34 - luminance) * 70, 0, 35)
    return Image.fromarray(heat, "RGB")


def metrics(reference: Image.Image, renderer: Image.Image) -> dict[str, float]:
    ref = np.asarray(reference, dtype=np.float32)
    rendered = np.asarray(renderer, dtype=np.float32)
    mae = float(np.abs(ref - rendered).mean() / 255.0)

    ref_edges = edge_mask(reference)
    rendered_edges = edge_mask(renderer)
    ref_near = np.asarray(
        Image.fromarray(ref_edges).filter(ImageFilter.MaxFilter(5)), dtype=bool
    )
    rendered_near = np.asarray(
        Image.fromarray(rendered_edges).filter(ImageFilter.MaxFilter(5)), dtype=bool
    )
    precision = float((rendered_edges & ref_near).sum() / max(rendered_edges.sum(), 1))
    recall = float((ref_edges & rendered_near).sum() / max(ref_edges.sum(), 1))
    edge_f1 = 2 * precision * recall / max(precision + recall, 1e-9)
    return {"mae": round(mae, 4), "edge_f1_2px": round(edge_f1, 4)}


def landmark_metrics(path: Path) -> dict[str, object]:
    actual = json.loads(path.read_text(encoding="utf-8"))
    errors: list[float] = []
    groups: dict[str, float] = {}

    for name in ("screen", "volume", "nav"):
        group_errors = [abs(actual[name][axis] - SVG_LANDMARKS[name][axis]) for axis in ("cx", "cy", "w", "h")]
        errors.extend(group_errors)
        groups[name] = round(sum(group_errors) / len(group_errors) * 100, 3)

    for name, y_key in (
        ("top_leds", "top_led_y"),
        ("top_switches", "top_switch_y"),
        ("bottom_leds", "bottom_led_y"),
        ("bottom_switches", "bottom_switch_y"),
    ):
        group_errors = []
        for index, landmark in enumerate(actual[name]):
            group_errors.extend((
                abs(landmark["cx"] - SVG_LANDMARKS["switch_x"][index]),
                abs(landmark["cy"] - SVG_LANDMARKS[y_key]),
            ))
        errors.extend(group_errors)
        groups[name] = round(sum(group_errors) / len(group_errors) * 100, 3)

    return {
        "mean_absolute_error_percent": round(sum(errors) / len(errors) * 100, 3),
        "maximum_error_percent": round(max(errors) * 100, 3),
        "group_mean_error_percent": groups,
        "source": "Neural DSP qc-overview-001.svg",
    }


def write_comparison(
    name: str, reference: Image.Image, renderer: Image.Image, output: Path
) -> dict[str, float]:
    reference.save(output / f"{name}-reference.jpg", quality=88, optimize=True)
    renderer.save(output / f"{name}-renderer.jpg", quality=90, optimize=True)
    Image.blend(reference, renderer, 0.5).save(
        output / f"{name}-overlay.jpg", quality=90, optimize=True
    )
    edge_overlay(reference, renderer).save(output / f"{name}-edges.png", optimize=True)
    difference_image(reference, renderer).save(output / f"{name}-difference.png", optimize=True)
    return metrics(reference, renderer)


def main() -> None:
    parser = argparse.ArgumentParser()
    panel_source = parser.add_mutually_exclusive_group(required=True)
    panel_source.add_argument("--photo", type=Path)
    panel_source.add_argument("--panel-reference", type=Path)
    parser.add_argument("--grid-reference", type=Path, required=True)
    parser.add_argument("--panel-renderer", type=Path, required=True)
    parser.add_argument("--grid-renderer", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--landmarks", type=Path)
    parser.add_argument("--label", default="comparison")
    args = parser.parse_args()

    args.output.mkdir(parents=True, exist_ok=True)
    panel_reference = (
        normalize(Image.open(args.panel_reference), PANEL_SIZE)
        if args.panel_reference
        else normalize_photo(args.photo)
    )
    panel_renderer = normalize(Image.open(args.panel_renderer), PANEL_SIZE)
    grid_reference = normalize_grid_reference(args.grid_reference)
    grid_renderer = normalize(Image.open(args.grid_renderer), GRID_SIZE)

    result = {
        "label": args.label,
        "panel": write_comparison("panel", panel_reference, panel_renderer, args.output),
        "grid": write_comparison("grid", grid_reference, grid_renderer, args.output),
        "sizes": {"panel": PANEL_SIZE, "grid": GRID_SIZE},
    }
    if args.landmarks:
        result["svg_landmarks"] = landmark_metrics(args.landmarks)
    (args.output / "metrics.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
