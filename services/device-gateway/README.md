# Device gateway

The normal single-owner process for Quad Cortex USB access. It composes `qc-core` with a device adapter, serializes commands, synchronizes authoritative state, and exposes private stdio IPC plus optional authenticated network transports.

The gateway is independently runnable and contains no desktop UI.

## Current development slice

Run `python main.py --stdio` from this directory to serve v1 length-prefixed
JSON-RPC on stdin/stdout. The Windows Tauri shell launches it automatically from
the repository virtual environment (or from `QC_GATEWAY_EXECUTABLE` when set),
keeps one persistent session, and exposes snapshot, scene, block-bypass, tuner,
and Gig View methods. Scene and bypass commands check the expected preset/scene;
bypass additionally requires readback confirmation. Persistent hardware writes
remain deliberately unavailable.
