"""Print printable-string neighbors around exact terms in a binary."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("binary", type=Path)
    parser.add_argument("terms", nargs="+")
    parser.add_argument("--radius", type=int, default=8)
    args = parser.parse_args()
    strings = [
        (match.start(), match.group().decode("ascii", "replace"))
        for match in re.finditer(rb"[ -~]{4,}", args.binary.read_bytes())
    ]
    wanted = {term.casefold() for term in args.terms}
    seen: set[tuple[int, int]] = set()
    for index, (_, value) in enumerate(strings):
        if not any(term in value.casefold() for term in wanted):
            continue
        bounds = (max(0, index - args.radius), min(len(strings), index + args.radius + 1))
        if bounds in seen:
            continue
        seen.add(bounds)
        print("---")
        for offset, text in strings[bounds[0] : bounds[1]]:
            print(f"0x{offset:x} {text[:500]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
