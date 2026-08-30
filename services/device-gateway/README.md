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
the user explicitly reloads the stored slot. The gateway also lists all user
setlist slots and exposes Save As with active-preset guards, an explicit occupied-slot
overwrite flag, device confirmation, slot readback, and final clean-state verification.
Factory-library and global-setting writes remain unavailable.

## Packaged runtime

`services/device-gateway/requirements.txt` pins the validated Windows HID and
protobuf runtime. The root `npm run build:installer` command installs the build
requirements, packages this service as a one-file console sidecar, and embeds it
in the Tauri NSIS installer. The console subsystem is required for framed
stdin/stdout IPC; the Windows host launches it with `CREATE_NO_WINDOW` so no
console is shown to the user.
