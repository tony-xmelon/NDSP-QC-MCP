# Shared native QC runtime

The installed Windows and Android applications use the same Rust protocol and
domain engine. Python is not part of either installed application's live path.

```text
Windows React -> Tauri -> qc-device-broker -> qc-device-runtime -> qc-protocol -> Windows HID
Android React -> Capacitor/JNI -------------------------------> qc-protocol -> Android USB
```

`qc-protocol` owns protobuf schemas, framing, session policy, typed outbound
commands, ModelRepo parsing, parameter scales/dependencies, and state decoding.
`qc-device-runtime` owns the platform-neutral complete snapshot reducer and
preset-library projection. The Windows broker owns only exclusive Windows HID,
background workers, framed `gateway.v1` IPC, device-event correlation, and
host-specific scheduling. Android's JNI layer owns its USB permission and
endpoint lifecycle.

Windows starts preset-folder enumeration when the directory is first opened.
Folder pushes are decoded and cached on the background receive lane. Starting
that device-wide transfer during the handshake would queue hundreds of File
messages ahead of live command readback, so it is deliberately kept out of the
startup and real-time paths.

The broker implements gateway API v2 directly, including snapshots, native
state frames, ModelRepo-backed block editors, scene/bypass/parameter/tempo and
Master Volume control, grid/routing writes, preset directory/slot listing,
recall/navigation/reload, save/rename/copy, and chunked native device backup.
It also owns device identity and naming, device undo/redo, compiler-inhibited
module state, stored-preset screenshots, CorOS 4.1 live screen capture, and
screen-coordinate tap sequences. Live tap sends the verified wire-value 1 then
wire-value 0 pair as one serialized worker operation after priming the
remote-screen session; CorOS 4.1 interprets those values opposite their recovered
`RELEASE`/`PRESS` labels.

On Windows the HID owner is full duplex: a permanent RX thread waits on the
input endpoint while the serialized broker lane writes on the same exclusive
handle. This matters for large device-originated transfers such as backup,
which keep receiving reports and sending keepalives without tearing down the
live session. LocalBackup assembly is boundary-aware because current firmware
does not correlate its chunks with the request id.
Windows performance footswitch and mode-slot actions remain direct Tauri MIDI
operations because MIDI endpoint selection is an operating-system concern.

## Python parity oracle

`services/device-gateway` and `pyquadcortex` remain source-only development
references. They are used for differential fixtures, protocol archaeology, and
future CorOS comparison. Set `QC_GATEWAY_RUNTIME=python` explicitly to run that
oracle during development. The Windows installer does not package it and the
normal application never starts it.

The vendored protobuf schema records its upstream MIT source and revision in
`packages/rust/qc-protocol/SCHEMA-SOURCE.md` and
`packages/rust/qc-protocol/PYQUADCORTEX-LICENSE.txt`.

## Verification

```powershell
cargo test --manifest-path packages/rust/qc-protocol/Cargo.toml
cargo test --manifest-path packages/rust/qc-device-runtime/Cargo.toml
cargo test --manifest-path services/device-broker/Cargo.toml
node tools/verify-packaged-gateway.mjs services/device-broker/target/debug/qc-device-broker.exe
```

`cargo run --manifest-path services/device-broker/Cargo.toml -- --verify-live`
changes the active scene, verifies the device echo, and restores it. Do not run
Cortex Control concurrently because QC HID access is exclusive.
