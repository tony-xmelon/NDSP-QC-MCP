"""Capture a Cortex Cloud product from WinINet request-body buffers.

The debugger observes only the initial body supplied to HttpSendRequestExW and
buffers passed to InternetWriteFile. It does not read request headers, cookies,
browser storage, or authentication dialogs. Captured JSON is sanitized before
it is persisted.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import time
from ctypes import wintypes
from pathlib import Path

from capture_cortex_product import product_from_bytes, sanitize
from capture_cortex_product_breakpoint import (
    CONTEXT_AMD64_CONTROL,
    DBG_CONTINUE,
    DBG_EXCEPTION_NOT_HANDLED,
    DEBUG_EVENT,
    EXCEPTION_BREAKPOINT,
    EXCEPTION_DEBUG_EVENT,
    INVALID_HANDLE_VALUE,
    MODULEENTRY32W,
    PROCESS_ALL_ACCESS,
    TH32CS_SNAPMODULE,
    TH32CS_SNAPMODULE32,
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
MAX_WRITE = 64 * 1024 * 1024
MAX_CAPTURE = 64 * 1024 * 1024


kernel32.Module32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
kernel32.Module32NextW.restype = wintypes.BOOL
kernel32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
kernel32.GetModuleHandleW.restype = wintypes.HMODULE
kernel32.GetProcAddress.argtypes = [wintypes.HMODULE, ctypes.c_char_p]
kernel32.GetProcAddress.restype = ctypes.c_void_p


def target_module_base(pid: int, module_name: str) -> int:
    snap = kernel32.CreateToolhelp32Snapshot(
        TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid
    )
    if snap == INVALID_HANDLE_VALUE:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        entry = MODULEENTRY32W()
        entry.dwSize = ctypes.sizeof(entry)
        ok = kernel32.Module32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szModule.casefold() == module_name.casefold():
                return ctypes.cast(entry.modBaseAddr, ctypes.c_void_p).value or 0
            ok = kernel32.Module32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    raise RuntimeError(f"{module_name} is not loaded in Cortex Control")


def target_export(pid: int, module_name: str, export_name: bytes) -> int:
    local_module = ctypes.WinDLL(module_name)
    local_base = kernel32.GetModuleHandleW(module_name)
    local_export = kernel32.GetProcAddress(local_base, export_name)
    if not local_export:
        raise ctypes.WinError(ctypes.get_last_error())
    rva = int(local_export) - int(local_base)
    return target_module_base(pid, module_name) + rva


def save_product(product: dict, output: Path) -> dict:
    clean = sanitize(product)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(clean, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return clean


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=90.0)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    pid = cortex_pid()
    write_breakpoint = target_export(pid, "wininet.dll", b"InternetWriteFile")
    send_breakpoint = target_export(pid, "wininet.dll", b"HttpSendRequestExW")
    process = kernel32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
    if not process:
        raise ctypes.WinError(ctypes.get_last_error())
    breakpoints = {
        write_breakpoint: read_exact(process, write_breakpoint, 1),
        send_breakpoint: read_exact(process, send_breakpoint, 1),
    }
    attached = False
    live_breakpoints: set[int] = set()
    rearm: tuple[int, int] | None = None
    event_pending = False
    event = DEBUG_EVENT()
    captured = bytearray()
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
                    "boundary": [
                        "wininet!HttpSendRequestExW",
                        "wininet!InternetWriteFile",
                    ],
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
                        argument = ctypes.c_uint64.from_address(context + 0x88).value
                        if address == write_breakpoint:
                            buffer_address = argument
                            byte_count = (
                                ctypes.c_uint64.from_address(context + 0xB8).value
                                & 0xFFFFFFFF
                            )
                        else:
                            try:
                                internet_buffers = read_exact(process, argument, 48)
                            except OSError:
                                internet_buffers = b""
                            if len(internet_buffers) >= 44:
                                buffer_address = int.from_bytes(
                                    internet_buffers[32:40], "little"
                                )
                                byte_count = int.from_bytes(
                                    internet_buffers[40:44], "little"
                                )
                            else:
                                buffer_address = 0
                                byte_count = 0
                        if 0 < byte_count <= MAX_WRITE and len(captured) < MAX_CAPTURE:
                            remaining = MAX_CAPTURE - len(captured)
                            captured.extend(
                                read_exact(process, buffer_address, min(byte_count, remaining))
                            )
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
                                        "body_bytes_observed": len(captured),
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
                {"captured": False, "pid": pid, "body_bytes_observed": len(captured)}
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
