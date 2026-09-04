"""Measure sustained Quad Cortex framebuffer capture performance."""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import struct
import sys
import time


from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
GATEWAY_SOURCE = REPOSITORY_ROOT / "services" / "device-gateway" / "src"
sys.path.insert(0, str(GATEWAY_SOURCE))

import pyquadcortex  # noqa: E402

from qc_device_gateway.remote_control import (  # noqa: E402
    capture_screen,
    install_remote_control_compat,
)


def percentile(samples: list[float], fraction: float) -> float:
    ordered = sorted(samples)
    position = (len(ordered) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


def png_dimensions(payload: bytes) -> tuple[int, int]:
    if not payload.startswith(b"\x89PNG\r\n\x1a\n") or len(payload) < 24:
        raise ValueError("capture was not a valid PNG")
    return struct.unpack(">II", payload[16:24])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frames", type=int, default=60)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument(
        "--burst-seconds",
        type=float,
        default=30.0,
        help="maximum time to wait for all queued burst responses",
    )
    parser.add_argument(
        "--burst",
        action="store_true",
        help="queue all READ requests immediately to test whether captures pipeline",
    )
    args = parser.parse_args()
    if args.frames < 1 or args.warmup < 0:
        parser.error("--frames must be positive and --warmup cannot be negative")

    message_class = install_remote_control_compat()
    qc = pyquadcortex.connect()
    try:
        for _ in range(args.warmup):
            capture_screen(qc, timeout=args.timeout)

        latencies: list[float] = []
        sizes: list[int] = []
        digests: set[str] = set()
        first_frame: bytes | None = None
        if args.burst:
            received: list[object] = []
            match = lambda message: (  # noqa: E731
                message.action == 1
                and message.HasField("screenshot")
                and bytes(message.screenshot.payload).startswith(b"\x89PNG\r\n\x1a\n")
            )
            entry = (message_class, match, received)
            with qc._t._lock:
                qc._t._collectors.append(entry)
            try:
                started = time.perf_counter()
                for _ in range(args.frames):
                    qc._t.send(message_class(action=3, screenshot={}))
                deadline = started + args.burst_seconds
                while len(received) < args.frames and time.perf_counter() < deadline:
                    time.sleep(0.002)
                elapsed = time.perf_counter() - started
            finally:
                with qc._t._lock:
                    if entry in qc._t._collectors:
                        qc._t._collectors.remove(entry)
            for message in received:
                payload = bytes(message.screenshot.payload)
                sizes.append(len(payload))
                digests.add(hashlib.sha256(payload).hexdigest())
                first_frame = first_frame or payload
        else:
            started = time.perf_counter()
            for _ in range(args.frames):
                frame_started = time.perf_counter()
                payload = capture_screen(qc, timeout=args.timeout)
                latencies.append(time.perf_counter() - frame_started)
                sizes.append(len(payload))
                digests.add(hashlib.sha256(payload).hexdigest())
                first_frame = first_frame or payload
            elapsed = time.perf_counter() - started
    finally:
        qc.close()

    if first_frame is None:
        raise RuntimeError("the QC returned no framebuffer responses")
    width, height = png_dimensions(first_frame)
    total_bytes = sum(sizes)
    result = {
        "mode": "burst" if args.burst else "sequential",
        "requestedFrames": args.frames,
        "receivedFrames": len(sizes),
        "resolution": {"width": width, "height": height},
        "elapsedSeconds": elapsed,
        "framesPerSecond": len(sizes) / elapsed,
        "payloadBytes": {
            "total": total_bytes,
            "mean": statistics.fmean(sizes),
            "min": min(sizes),
            "max": max(sizes),
        },
        "payloadBandwidthBytesPerSecond": total_bytes / elapsed,
        "latencyMilliseconds": None if args.burst else {
            "mean": statistics.fmean(latencies) * 1000,
            "median": statistics.median(latencies) * 1000,
            "p95": percentile(latencies, 0.95) * 1000,
            "p99": percentile(latencies, 0.99) * 1000,
            "min": min(latencies) * 1000,
            "max": max(latencies) * 1000,
        },
        "uniqueFrames": len(digests),
    }
    rendered = json.dumps(result, indent=2)
    print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
