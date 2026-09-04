"""Capture and sanitize an in-memory Cortex Cloud product JSON object.

This diagnostic intentionally reads only the Cortex Control process. It searches
readable, writable memory for JSON objects containing the Cloud product fields,
redacts account identifiers, and never inspects HTTP headers or browser state.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import time
from ctypes import wintypes
from pathlib import Path


PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01
WRITABLE_PAGES = {0x04, 0x08, 0x40, 0x80}
MAX_REGION = 256 * 1024 * 1024
READ_CHUNK = 8 * 1024 * 1024
OVERLAP = 256 * 1024


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("PartitionId", wintypes.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.ReadProcessMemory.restype = wintypes.BOOL
kernel32.VirtualQueryEx.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.POINTER(MEMORY_BASIC_INFORMATION),
    ctypes.c_size_t,
]
kernel32.VirtualQueryEx.restype = ctypes.c_size_t
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def cortex_pid() -> int:
    import subprocess

    result = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq Cortex Control.exe", "/FO", "CSV", "/NH"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    for line in result.stdout.splitlines():
        if line.startswith('"Cortex Control.exe"'):
            return int(line.split(",")[1].strip('"'))
    raise RuntimeError("Cortex Control is not running")


def readable_writable_regions(handle: int):
    address = 0
    maximum = 0x00007FFFFFFFFFFF
    mbi = MEMORY_BASIC_INFORMATION()
    while address < maximum:
        queried = kernel32.VirtualQueryEx(
            handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)
        )
        if not queried:
            address += 0x1000
            continue
        base = int(mbi.BaseAddress or 0)
        size = int(mbi.RegionSize)
        protection = int(mbi.Protect)
        if (
            mbi.State == MEM_COMMIT
            and not protection & (PAGE_GUARD | PAGE_NOACCESS)
            and protection & 0xFF in WRITABLE_PAGES
            and 0 < size <= MAX_REGION
        ):
            yield base, size
        address = max(address + 0x1000, base + max(size, 0x1000))


def read_memory(handle: int, address: int, size: int) -> bytes:
    buffer = ctypes.create_string_buffer(size)
    received = ctypes.c_size_t()
    if not kernel32.ReadProcessMemory(
        handle,
        ctypes.c_void_p(address),
        buffer,
        size,
        ctypes.byref(received),
    ):
        return b""
    return buffer.raw[: received.value]


def product_from_bytes(data: bytes):
    needles = (b'"payload"', b'"payload_hash"')
    for needle in needles:
        offset = 0
        while True:
            found = data.find(needle, offset)
            if found < 0:
                break
            offset = found + len(needle)
            search_start = max(0, found - 128 * 1024)
            starts = [i for i in range(search_start, found) if data[i] == 0x7B]
            for start in reversed(starts[-64:]):
                try:
                    text = data[start:].decode("utf-8", errors="strict")
                    value, _ = json.JSONDecoder().raw_decode(text)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if (
                    isinstance(value, dict)
                    and isinstance(value.get("payload"), str)
                    and "payload_hash" in value
                    and value.get("type") in {"preset", "capture", "ir", "backup"}
                ):
                    return value
    return None


def scan_once(handle: int):
    for base, size in readable_writable_regions(handle):
        previous = b""
        cursor = 0
        while cursor < size:
            amount = min(READ_CHUNK, size - cursor)
            current = read_memory(handle, base + cursor, amount)
            if current:
                candidate = previous + current
                product = product_from_bytes(candidate)
                if product is not None:
                    return product
                previous = candidate[-OVERLAP:]
            cursor += amount
    return None


def sanitize(product: dict) -> dict:
    clean = dict(product)
    for field in ("author_id", "user_id", "owner_id"):
        if field in clean:
            clean[field] = "<redacted>"
    return clean


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=30.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    pid = cortex_pid()
    handle = kernel32.OpenProcess(
        PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid
    )
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            product = scan_once(handle)
            if product is not None:
                clean = sanitize(product)
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.write_text(
                    json.dumps(clean, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8",
                )
                print(
                    json.dumps(
                        {
                            "captured": True,
                            "name": clean.get("name"),
                            "type": clean.get("type"),
                            "payload_chars": len(clean.get("payload", "")),
                            "fields": sorted(clean),
                            "output": os.fspath(args.output.resolve()),
                        }
                    )
                )
                return 0
            time.sleep(0.05)
    finally:
        kernel32.CloseHandle(handle)
    print(json.dumps({"captured": False, "pid": pid}))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
