"""Capture one request-body candidate from each Cortex Control WriteFile callsite.

Breakpoints are one-shot and placed in Cortex Control itself, avoiding the hot
system API. Only buffers that form a Cortex product JSON are persisted.
"""

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


WRITE_CALL_RVAS = (
    0x00488D69,
    0x01196A3A,
    0x011A8A78,
    0x014B17C0,
    0x014B1B27,
    0x014B1B6D,
    0x014B1E43,
    0x014B1F5E,
    0x014B20C7,
    0x014B2535,
    0x014B5B2C,
    0x015857EF,
    0x015AB586,
    0x015ADDB2,
    0x015BEE4C,
    0x015BEF1B,
    0x015D1D81,
)
MAX_WRITE = 32 * 1024 * 1024


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=90.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    pid = cortex_pid()
    base = module_base(pid)
    process = kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    breakpoints = {base + rva: read_exact(process, base + rva, 1) for rva in WRITE_CALL_RVAS}
    if any(byte != b"\xFF" for byte in breakpoints.values()):
        raise RuntimeError("one or more WriteFile callsites no longer match Cortex Control 4.1.0")
    live = set()
    attached = False
    event_pending = False
    event = DEBUG_EVENT()
    buffers = bytearray()
    hits: list[dict] = []
    try:
        if not kernel32.DebugActiveProcess(pid):
            raise ctypes.WinError(ctypes.get_last_error())
        attached = True
        for address in breakpoints:
            write_exact(process, address, b"\xCC")
            live.add(address)
        print(json.dumps({"armed": True, "pid": pid, "callsites": len(live)}), flush=True)
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline and live:
            if not kernel32.WaitForDebugEvent(ctypes.byref(event), 500):
                error = ctypes.get_last_error()
                if error == 121:
                    continue
                raise ctypes.WinError(error)
            event_pending = True
            status = DBG_CONTINUE
            if event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT:
                record = event.u.Exception.ExceptionRecord
                address = int(record.ExceptionAddress or 0)
                if record.ExceptionCode == EXCEPTION_BREAKPOINT and address in live:
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
                        observed = 0
                        if buffer_address and 0 < size <= MAX_WRITE:
                            try:
                                data = read_exact(process, buffer_address, size)
                                buffers.extend(data)
                                observed = len(data)
                            except OSError:
                                pass
                        hits.append({"rva": hex(address - base), "bytes": observed})
                        write_exact(process, address, breakpoints[address])
                        live.remove(address)
                        ctypes.c_uint64.from_address(context + 0xF8).value = address
                        if not kernel32.SetThreadContext(thread, ctypes.c_void_p(context)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        product = product_from_bytes(bytes(buffers))
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
                                        "hits": hits,
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
                elif record.ExceptionCode != EXCEPTION_BREAKPOINT:
                    status = DBG_EXCEPTION_NOT_HANDLED
            kernel32.ContinueDebugEvent(event.dwProcessId, event.dwThreadId, status)
            event_pending = False
        print(json.dumps({"captured": False, "pid": pid, "hits": hits}), flush=True)
        return 2
    finally:
        for address in list(live):
            try:
                write_exact(process, address, breakpoints[address])
            except OSError:
                pass
        if event_pending:
            kernel32.ContinueDebugEvent(event.dwProcessId, event.dwThreadId, DBG_CONTINUE)
        if attached:
            kernel32.DebugActiveProcessStop(pid)
        kernel32.CloseHandle(process)


if __name__ == "__main__":
    raise SystemExit(main())
