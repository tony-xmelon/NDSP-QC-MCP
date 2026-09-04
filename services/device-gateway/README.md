# Device gateway

The normal single-owner process for Quad Cortex USB access. It composes `qc-core` with a device adapter, serializes commands, synchronizes authoritative state, and exposes private stdio IPC plus optional authenticated network transports.

The gateway is independently runnable and contains no desktop UI.

## Development-only parity runtime

Run `python main.py --stdio` from this directory to serve v1 length-prefixed
JSON-RPC on stdin/stdout. It is selected only when a developer explicitly sets
`QC_GATEWAY_RUNTIME=python`. The installed Windows and Android applications use
the shared native Rust runtime instead. This service implements the same manifest-defined gateway
contract as the Rust runtime. The pyquadcortex-backed parity methods require an upstream
release containing the identity/history, preset-screenshot, and remote-screen APIs. It exposes snapshot, scene, block-bypass, guarded
installed model discovery, guarded block placement/removal/same-row movement,
STOMP footswitch assignment, guarded row input/output and branch/rejoin routing, preset
directory/recall, bank navigation, tuner, and Gig View methods. State-changing
commands check the expected preset/scene/slot and use correlated replies or
readback. Numeric and option block parameters are catalog-driven and require
expected-value plus dirty-state verification. Dirty presets block recall until
the user explicitly reloads the stored slot. The gateway also lists all user
setlist slots and exposes Save As with active-preset guards, an explicit occupied-slot
overwrite flag, device confirmation, slot readback, and final clean-state verification.
Factory-library writes remain unavailable. Device naming, undo/redo, inhibited-module reads,
preset screenshots, physical-screen capture, and guarded screen taps use the corresponding
public pyquadcortex operations rather than duplicating protobuf logic in this adapter.

## Packaging

`services/device-gateway/requirements.txt` pins the development oracle's HID and
protobuf dependencies. It is not packaged in Windows or Android releases and is
not part of the normal application runtime.
