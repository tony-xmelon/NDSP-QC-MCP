"""Capture a Cortex Cloud product from Cortex Control's USB I/O buffers.

Only data passed through KernelBase ReadFile/WriteFile is observed. The tool
retains traffic briefly in memory, extracts a Cortex product JSON object, then
persists only a sanitized JSON artifact. Unrelated traffic is never written.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import time
from pathlib import Path

from capture_cortex_internet_write import save_product, target_export
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
    read_exact,
    write_exact,
)


EXCEPTION_SINGLE_STEP = 0x80000004
MAX_IO = 16 * 1024 * 1024
MAX_CAPTURE = 128 * 1024 * 1024


def append_buffer(target: bytearray, process: int, address: int, size: int) -> None:
    if not address or size <= 0 or size > MAX_IO or len(target) >= MAX_CAPTURE:
        return
    try:
        data = read_exact(process, address, min(size, MAX_CAPTURE - len(target)))
    except OSError:
        return
    target.extend(data)


def find_product(inbound: bytearray, outbound: bytearray):
    for data in (inbound, outbound):
        product = product_from_bytes(bytes(data))
        if product is not None:
            return product
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=90.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    pid = cortex_pid()
    read_breakpoint = target_export(pid, "kernelbase.dll", b"ReadFile")
    write_breakpoint = target_export(pid, "kernelbase.dll", b"WriteFile")
    process = kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    breakpoints = {
        read_breakpoint: read_exact(process, read_breakpoint, 1),
        write_breakpoint: read_exact(process, write_breakpoint, 1),
    }
    attached = False
    live_breakpoints: set[int] = set()
    rearm: tuple[int, int] | None = None
    event_pending = False
    event = DEBUG_EVENT()
    pending_reads: dict[int, tuple[int, int, int]] = {}
    inbound = bytearray()
    outbound = bytearray()
    read_calls = 0
    write_calls = 0
    try:
        if not kernel32.DebugActiveProcess(pid):
            raise ctypes.WinError(ctypes.get_last_error())
        attached = True
        for address in breakpoints:
            write_exact(process, address, b"\xCC")
            live_breakpoints.add(address)
        print(
            json.dumps(
                {
                    "armed": True,
                    "pid": pid,
                    "boundary": ["kernelbase!ReadFile", "kernelbase!WriteFile"],
                }
            ),
            flush=True,
        )
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
                if code == EXCEPTION_BREAKPOINT and address in breakpoints:
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
                        handle = ctypes.c_uint64.from_address(context + 0x80).value
                        buffer_address = ctypes.c_uint64.from_address(context + 0x88).value
                        size = ctypes.c_uint64.from_address(context + 0xB8).value & 0xFFFFFFFF
                        bytes_pointer = ctypes.c_uint64.from_address(context + 0xC0).value
                        if address == read_breakpoint:
                            read_calls += 1
                            previous = pending_reads.pop(handle, None)
                            if previous is not None:
                                previous_buffer, maximum, previous_count_pointer = previous
                                actual = maximum
                                if previous_count_pointer:
                                    try:
                                        actual = int.from_bytes(
                                            read_exact(process, previous_count_pointer, 4), "little"
                                        )
                                    except OSError:
                                        pass
                                append_buffer(inbound, process, previous_buffer, min(actual, maximum))
                            pending_reads[handle] = (buffer_address, size, bytes_pointer)
                        else:
                            write_calls += 1
                            append_buffer(outbound, process, buffer_address, size)
                        write_exact(process, address, breakpoints[address])
                        live_breakpoints.discard(address)
                        ctypes.c_uint64.from_address(context + 0xF8).value = address
                        eflags = ctypes.c_uint32.from_address(context + 0x44)
                        eflags.value |= 0x100
                        if not kernel32.SetThreadContext(thread, ctypes.c_void_p(context)):
                            raise ctypes.WinError(ctypes.get_last_error())
                        rearm = (event.dwThreadId, address)
                    finally:
                        kernel32.CloseHandle(thread)
                elif (
                    code == EXCEPTION_SINGLE_STEP
                    and rearm is not None
                    and event.dwThreadId == rearm[0]
                ):
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
                        rearm_address = rearm[1]
                        write_exact(process, rearm_address, b"\xCC")
                        live_breakpoints.add(rearm_address)
                        rearm = None
                        product = find_product(inbound, outbound)
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
                                        "read_calls": read_calls,
                                        "write_calls": write_calls,
                                        "input_bytes_observed": len(inbound),
                                        "output_bytes_observed": len(outbound),
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
                {
                    "captured": False,
                    "pid": pid,
                    "read_calls": read_calls,
                    "write_calls": write_calls,
                    "input_bytes_observed": len(inbound),
                    "output_bytes_observed": len(outbound),
                }
            ),
            flush=True,
        )
        return 2
    finally:
        for address in list(live_breakpoints):
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
