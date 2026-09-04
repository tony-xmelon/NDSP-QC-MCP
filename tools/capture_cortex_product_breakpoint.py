"""Capture Cortex Control's product JSON at its pre-multipart boundary.

Verified against Cortex Control 4.1.0. The software breakpoint is placed after
the routine that returns the upload JSON and before multipart construction. The
original byte is restored before the application resumes. HTTP headers are not
read. Account identifiers are redacted in the saved diagnostic artifact.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import struct
import subprocess
import time
from ctypes import wintypes
from pathlib import Path


PROCESS_ALL_ACCESS = 0x001F0FFF
THREAD_GET_CONTEXT = 0x0008
THREAD_SET_CONTEXT = 0x0010
THREAD_QUERY_INFORMATION = 0x0040
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
CONTEXT_AMD64_CONTROL = 0x00100001
CONTEXT_AMD64_INTEGER = 0x00100002
EXCEPTION_DEBUG_EVENT = 1
EXCEPTION_BREAKPOINT = 0x80000003
DBG_CONTINUE = 0x00010002
DBG_EXCEPTION_NOT_HANDLED = 0x80010001
BREAKPOINT_RVA = 0x01AE0CD1
MAX_JSON = 32 * 1024 * 1024


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("th32ModuleID", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("GlblcntUsage", wintypes.DWORD),
        ("ProccntUsage", wintypes.DWORD),
        ("modBaseAddr", ctypes.POINTER(ctypes.c_ubyte)),
        ("modBaseSize", wintypes.DWORD),
        ("hModule", wintypes.HMODULE),
        ("szModule", wintypes.WCHAR * 256),
        ("szExePath", wintypes.WCHAR * 260),
    ]


class EXCEPTION_RECORD(ctypes.Structure):
    _fields_ = [
        ("ExceptionCode", wintypes.DWORD),
        ("ExceptionFlags", wintypes.DWORD),
        ("ExceptionRecord", ctypes.c_void_p),
        ("ExceptionAddress", ctypes.c_void_p),
        ("NumberParameters", wintypes.DWORD),
        ("_padding", wintypes.DWORD),
        ("ExceptionInformation", ctypes.c_size_t * 15),
    ]


class EXCEPTION_DEBUG_INFO(ctypes.Structure):
    _fields_ = [
        ("ExceptionRecord", EXCEPTION_RECORD),
        ("dwFirstChance", wintypes.DWORD),
    ]


class DEBUG_EVENT_UNION(ctypes.Union):
    _fields_ = [
        ("Exception", EXCEPTION_DEBUG_INFO),
        ("raw", ctypes.c_ubyte * 176),
    ]


class DEBUG_EVENT(ctypes.Structure):
    _fields_ = [
        ("dwDebugEventCode", wintypes.DWORD),
        ("dwProcessId", wintypes.DWORD),
        ("dwThreadId", wintypes.DWORD),
        ("u", DEBUG_EVENT_UNION),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenThread.restype = wintypes.HANDLE
kernel32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.ReadProcessMemory.restype = wintypes.BOOL
kernel32.WriteProcessMemory.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.WriteProcessMemory.restype = wintypes.BOOL
kernel32.VirtualProtectEx.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_size_t,
    wintypes.DWORD,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.VirtualProtectEx.restype = wintypes.BOOL
kernel32.FlushInstructionCache.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_size_t,
]
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.Module32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
kernel32.Module32FirstW.restype = wintypes.BOOL
kernel32.DebugActiveProcess.argtypes = [wintypes.DWORD]
kernel32.DebugActiveProcess.restype = wintypes.BOOL
kernel32.DebugActiveProcessStop.argtypes = [wintypes.DWORD]
kernel32.DebugActiveProcessStop.restype = wintypes.BOOL
kernel32.WaitForDebugEvent.argtypes = [ctypes.POINTER(DEBUG_EVENT), wintypes.DWORD]
kernel32.WaitForDebugEvent.restype = wintypes.BOOL
kernel32.ContinueDebugEvent.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD]
kernel32.ContinueDebugEvent.restype = wintypes.BOOL
kernel32.GetThreadContext.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.GetThreadContext.restype = wintypes.BOOL
kernel32.SetThreadContext.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.SetThreadContext.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def cortex_pid() -> int:
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


def module_base(pid: int) -> int:
    snap = kernel32.CreateToolhelp32Snapshot(
        TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid
    )
    if snap == INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = MODULEENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        if not kernel32.Module32FirstW(snap, ctypes.byref(entry)):
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.cast(entry.modBaseAddr, ctypes.c_void_p).value or 0
    finally:
        kernel32.CloseHandle(snap)


def read_exact(process: int, address: int, size: int) -> bytes:
    buffer = ctypes.create_string_buffer(size)
    received = ctypes.c_size_t()
    if not kernel32.ReadProcessMemory(
        process, ctypes.c_void_p(address), buffer, size, ctypes.byref(received)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return buffer.raw[: received.value]


def write_exact(process: int, address: int, data: bytes) -> None:
    old = wintypes.DWORD()
    if not kernel32.VirtualProtectEx(
        process, ctypes.c_void_p(address), len(data), 0x40, ctypes.byref(old)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        written = ctypes.c_size_t()
        source = ctypes.create_string_buffer(data)
        if not kernel32.WriteProcessMemory(
            process,
            ctypes.c_void_p(address),
            source,
            len(data),
            ctypes.byref(written),
        ) or written.value != len(data):
            raise ctypes.WinError(ctypes.get_last_error())
        kernel32.FlushInstructionCache(process, ctypes.c_void_p(address), len(data))
    finally:
        restored = wintypes.DWORD()
        kernel32.VirtualProtectEx(
            process, ctypes.c_void_p(address), len(data), old.value, ctypes.byref(restored)
        )


def aligned_context():
    allocation = ctypes.create_string_buffer(0x4D0 + 16)
    address = (ctypes.addressof(allocation) + 15) & ~15
    ctypes.c_uint32.from_address(address + 0x30).value = (
        CONTEXT_AMD64_CONTROL | CONTEXT_AMD64_INTEGER
    )
    return allocation, address


def read_c_string(process: int, address: int) -> bytes:
    result = bytearray()
    while len(result) < MAX_JSON:
        chunk = read_exact(process, address + len(result), min(65536, MAX_JSON - len(result)))
        if not chunk:
            break
        nul = chunk.find(b"\0")
        if nul >= 0:
            result.extend(chunk[:nul])
            break
        result.extend(chunk)
    return bytes(result)


def sanitize_json(raw: bytes) -> tuple[dict, bytes]:
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("payload"), str):
        raise ValueError("captured value is not a Cortex product JSON object")
    for field in ("author_id", "user_id", "owner_id"):
        if field in value:
            value[field] = "<redacted>"
    clean = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    return value, clean


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=90.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    pid = cortex_pid()
    base = module_base(pid)
    breakpoint = base + BREAKPOINT_RVA
    process = kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    original = read_exact(process, breakpoint, 1)
    if original != b"\x48":
        raise RuntimeError(f"unexpected breakpoint byte: {original.hex()}")

    attached = False
    breakpoint_live = False
    event_pending = False
    event = DEBUG_EVENT()
    try:
        if not kernel32.DebugActiveProcess(pid):
            raise ctypes.WinError(ctypes.get_last_error())
        attached = True
        write_exact(process, breakpoint, b"\xCC")
        breakpoint_live = True
        print(json.dumps({"armed": True, "pid": pid, "breakpoint_rva": hex(BREAKPOINT_RVA)}), flush=True)
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline:
            if not kernel32.WaitForDebugEvent(ctypes.byref(event), 500):
                error = ctypes.get_last_error()
                if error == 121:
                    continue
                raise ctypes.WinError(error)
            event_pending = True
            status = DBG_CONTINUE
            if event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT:
                record = event.u.Exception.ExceptionRecord
                exception_address = int(record.ExceptionAddress or 0)
                if record.ExceptionCode == EXCEPTION_BREAKPOINT and exception_address == breakpoint:
                    thread = kernel32.OpenThread(
                        THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_QUERY_INFORMATION,
                        False,
                        event.dwThreadId,
                    )
                    if not thread:
                        raise ctypes.WinError(ctypes.get_last_error())
                    try:
                        allocation, context = aligned_context()
                        if not kernel32.GetThreadContext(thread, ctypes.c_void_p(context)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        rsp = ctypes.c_uint64.from_address(context + 0x98).value
                        string_pointer = struct.unpack("<Q", read_exact(process, rsp + 0x40, 8))[0]
                        raw = read_c_string(process, string_pointer)
                        product, clean = sanitize_json(raw)
                        args.output.parent.mkdir(parents=True, exist_ok=True)
                        args.output.write_bytes(clean)
                        write_exact(process, breakpoint, original)
                        breakpoint_live = False
                        ctypes.c_uint64.from_address(context + 0xF8).value = breakpoint
                        if not kernel32.SetThreadContext(thread, ctypes.c_void_p(context)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        print(
                            json.dumps(
                                {
                                    "captured": True,
                                    "name": product.get("name"),
                                    "type": product.get("type"),
                                    "payload_chars": len(product.get("payload", "")),
                                    "fields": sorted(product),
                                    "output": os.fspath(args.output.resolve()),
                                }
                            ),
                            flush=True,
                        )
                    finally:
                        kernel32.CloseHandle(thread)
                    kernel32.ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE)
                    event_pending = False
                    return 0
                if record.ExceptionCode != EXCEPTION_BREAKPOINT:
                    status = DBG_EXCEPTION_NOT_HANDLED
            kernel32.ContinueDebugEvent(event.dwProcessId, event.dwThreadId, status)
            event_pending = False
        print(json.dumps({"captured": False, "pid": pid}), flush=True)
        return 2
    finally:
        if breakpoint_live:
            try:
                write_exact(process, breakpoint, original)
            except OSError:
                pass
        if event_pending:
            kernel32.ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE)
        if attached:
            kernel32.DebugActiveProcessStop(pid)
        kernel32.CloseHandle(process)


if __name__ == "__main__":
    raise SystemExit(main())
