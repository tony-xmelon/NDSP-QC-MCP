"""Verify checksums, geometry, and state metadata for official SVG details."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("corpus", type=Path)
    args = parser.parse_args()
    manifest = json.loads((args.corpus / "manifest.json").read_text(encoding="utf-8"))
    assets = manifest["assets"]
    seen: set[str] = set()
    for asset in assets:
        assert asset["id"] not in seen, f"duplicate asset id {asset['id']}"
        seen.add(asset["id"])
        path = args.corpus / asset["image"]
        payload = path.read_bytes()
        assert len(payload) == asset["bytes"], f"{asset['id']}: byte count mismatch"
        assert hashlib.sha256(payload).hexdigest() == asset["sha256"], f"{asset['id']}: checksum mismatch"
        tag = re.search(r"<svg\b[^>]*>", payload[:2000].decode("utf-8", "replace"), re.IGNORECASE)
        assert tag, f"{asset['id']}: not an SVG"
        assert f'width="{asset["width"]}"' in tag.group(0), f"{asset['id']}: width mismatch"
        assert f'height="{asset["height"]}"' in tag.group(0), f"{asset['id']}: height mismatch"
        assert f'viewBox="{asset["viewBox"]}"' in tag.group(0), f"{asset['id']}: viewBox mismatch"
        assert asset["states"], f"{asset['id']}: no canonical state mapping"
    source_files = {path.name for path in args.corpus.glob("*.svg")}
    manifest_files = {asset["image"] for asset in assets}
    assert source_files == manifest_files, "manifest and SVG file set differ"
    print(f"PASS {len(assets)} official SVG details; checksums, geometry, and state mappings match")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
