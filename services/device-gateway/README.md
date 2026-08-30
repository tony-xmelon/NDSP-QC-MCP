# Device gateway

The normal single-owner process for Quad Cortex USB access. It composes `qc-core` with a device adapter, serializes commands, synchronizes authoritative state, and exposes private stdio IPC plus optional authenticated network transports.

The gateway is independently runnable and contains no desktop UI.

## Current development slice

Run `python main.py --stdio` from this directory to serve v1 length-prefixed
JSON-RPC on stdin/stdout. The Windows Tauri shell launches it automatically from
the repository virtual environment (or from `QC_GATEWAY_EXECUTABLE` when set),
keeps one persistent session, and exposes snapshot, scene, block-bypass, preset
directory/recall, bank navigation, tuner, and Gig View methods. State-changing
commands check the expected preset/scene/slot and use correlated replies or
readback. Numeric and option block parameters are catalog-driven and require
expected-value plus dirty-state verification. Dirty presets block recall until
the user explicitly reloads the stored slot. Persistent hardware writes remain
deliberately unavailable.
