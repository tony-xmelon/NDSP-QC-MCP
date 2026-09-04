"""Capture product JSON from Cortex Control's single device-write callsite."""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import time
from pathlib import Path

from capture_cortex_internet_write import save_product
from capture_cortex_product import product_from_bytes
from capture_cortex_product_breakpoint import (
    DBG_CONTINUE,
    DBG_EXCEPTION_NOT_HANDLED,
    DEBUG_EVENT,
    EXCEPTION_BREAKPOINT,
    EXCEPTION_DEBUG_EVENT,
    PROCESS_ALL_ACCESS,
    THREAD_GET_CONTEXT,
    THREAD_QUERY_INFORMATION,
    THREAD_SET_CONTEXT,
    aligned_context,
    cortex_pid,
    kernel32,
    module_base,
    read_exact,
    write_exact,
)


EXCEPTION_SINGLE_STEP = 0x80000004
DEVICE_WRITE_RVA = 0x01196A3A
MAX_WRITE = 16 * 1024 * 1024
MAX_CAPTURE = 128 * 1024 * 1024


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=90.0)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--reports-output",
        type=Path,
        help="Optional local binary trace of the 129-byte QC HID reports.",
    )
    args = parser.parse_args()
    pid = cortex_pid()
    base = module_base(pid)
    breakpoint = base + DEVICE_WRITE_RVA
    process = kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    original = read_exact(process, breakpoint, 1)
    if original != b"\xFF":
        raise RuntimeError(f"unexpected callsite byte: {original.hex()}")
    attached = False
    live = False
    rearming_thread = 0
    event_pending = False
    event = DEBUG_EVENT()
    captured = bytearray()
    calls = 0
    sizes: dict[int, int] = {}
    try:
        if not kernel32.DebugActiveProcess(pid):
            raise ctypes.WinError(ctypes.get_last_error())
        attached = True
        write_exact(process, breakpoint, b"\xCC")
        live = True
        print(json.dumps({"armed": True, "pid": pid, "rva": hex(DEVICE_WRITE_RVA)}), flush=True)
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
                code = record.ExceptionCode
                address = int(record.ExceptionAddress or 0)
                if code == EXCEPTION_BREAKPOINT and address == breakpoint:
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
                        buffer_address = ctypes.c_uint64.from_address(context + 0x88).value
                        size = ctypes.c_uint64.from_address(context + 0xB8).value & 0xFFFFFFFF
                        calls += 1
                        sizes[size] = sizes.get(size, 0) + 1
                        if buffer_address and 0 < size <= MAX_WRITE and len(captured) < MAX_CAPTURE:
                            try:
                                report = read_exact(
                                    process,
                                    buffer_address,
                                    min(size, MAX_CAPTURE - len(captured)),
                                )
                                captured.extend(report)
                                if args.reports_output is not None:
                                    args.reports_output.parent.mkdir(parents=True, exist_ok=True)
                                    with args.reports_output.open("ab") as trace:
                                        trace.write(report)
                            except OSError:
                                pass
                        write_exact(process, breakpoint, original)
                        live = False
                        ctypes.c_uint64.from_address(context + 0xF8).value = breakpoint
                        eflags = ctypes.c_uint32.from_address(context + 0x44)
                        eflags.value |= 0x100
                        if not kernel32.SetThreadContext(thread, ctypes.c_void_p(context)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        rearming_thread = event.dwThreadId
                    finally:
                        kernel32.CloseHandle(thread)
                elif code == EXCEPTION_SINGLE_STEP and event.dwThreadId == rearming_thread:
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
                        eflags = ctypes.c_uint32.from_address(context + 0x44)
                        eflags.value &= ~0x100
                        if not kernel32.SetThreadContext(thread, ctypes.c_void_p(context)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        write_exact(process, breakpoint, b"\xCC")
                        live = True
                        rearming_thread = 0
                        product = product_from_bytes(bytes(captured))
                        if product is not None:
                            clean = save_product(product, args.output)
                            print(
                                json.dumps(
                                    {
                                        "captured": True,
                                        "name": clean.get("name"),
                                        "type": clean.get("type"),
                                        "payload_chars": len(clean.get("payload", "")),
                                        "fields": sorted(clean),
                                        "calls": calls,
                                        "sizes": sizes,
                                        "output": os.fspath(args.output.resolve()),
                                    }
                                ),
                                flush=True,
                            )
                            kernel32.ContinueDebugEvent(
                                event.dwProcessId, event.dwThreadId, DBG_CONTINUE
                            )
                            event_pending = False
                            return 0
                    finally:
                        kernel32.CloseHandle(thread)
                elif code not in (EXCEPTION_BREAKPOINT, EXCEPTION_SINGLE_STEP):
                    status = DBG_EXCEPTION_NOT_HANDLED
            kernel32.ContinueDebugEvent(event.dwProcessId, event.dwThreadId, status)
            event_pending = False
        print(
            json.dumps(
                {"captured": False, "pid": pid, "calls": calls, "sizes": sizes}
            ),
            flush=True,
        )
        return 2
    finally:
        if live:
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
