# NDSP QC MCP

An unofficial, modular control platform for Neural DSP Quad Cortex devices. The project is intended to support a hardware-faithful Windows controller, a standalone MCP server, and future Android, iOS, web, and other clients without duplicating device-control logic.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by Neural DSP. Protocol support currently relies on the community-maintained `pyquadcortex` project and must be treated as compatibility-sensitive.

## Repository shape

```text
apps/                       End-user clients
  windows/                  Tauri + web UI desktop client
  android/                  Future Android composition root
  ios/                      Future iOS composition root
services/                   Independently runnable processes
  device-gateway/           The single QC owner; local IPC and optional LAN API
  mcp-server/               Standalone MCP server
packages/
  python/
    qc-core/                Pure device model, use cases, ports, safety rules
    qc-pyquadcortex/        pyquadcortex USB-HID adapter
    qc-gateway-client/      Client for a running device gateway
  typescript/
    qc-client/              Generated contracts, API client, shared state
    qc-ui/                  Platform-neutral web UI primitives
    qc-form-factors/        QC geometry, skins, and control manifests
contracts/                  Versioned wire schemas; the cross-language source of truth
docs/                       Product, architecture, and decision records
tests/                      Cross-module contract and real-hardware tests
```

Every directory initially contains a boundary document. Code is added only to the module that owns the responsibility.

## Architectural rules

- `qc-core` contains no HID, MCP, HTTP, UI, Tauri, or operating-system imports.
- `qc-pyquadcortex` is the only module that knows the `pyquadcortex` API.
- Exactly one process owns the QC USB-HID session at a time.
- Clients communicate in typed domain commands and events, never protobuf packets or raw grid coordinates.
- `contracts/` is the source of truth for cross-process and cross-language messages.
- The MCP server is independently installable and never imports a desktop or mobile app.
- Form-factor geometry, skins, and behavior are separate; adding a client or skin must not change device logic.
- AI is an optional adapter. Manual device control continues to work without an AI provider.

See [Architecture](docs/ARCHITECTURE.md) and the [Windows implementation plan](docs/WINDOWS_IMPLEMENTATION_PLAN.md).

## Status

The Windows client now has a Tauri/WebView2 shell, reusable hardware surface,
form-factor/skin packages, keyboard/mouse interaction, connection diagnostics,
menus, chat composer, and microphone capture lifecycle. Its persistent Python
device gateway owns the QC HID session and hydrates the UI from a live preset
snapshot over private framed JSON-RPC. Scene selection, block bypass, tuner, and
Gig View controls are enabled, along with mode-aware A–H footswitch emulation
through the QC's Windows MIDI endpoint and verified tempo/encoder/tap control,
live setlist browsing, guarded preset
recall, bank navigation, metadata-driven block parameter editing, and explicit
dirty-state recovery. The Grid rails and split/rejoin markers are derived from
the live preset's four-row routing topology rather than demo labels, including
parallel-lane blocks and split/rejoin points. Visible device state synchronizes
in the background so touchscreen changes appear without a manual refresh.
Explicit disconnect/reconnect, a privacy-safe connection
log, current-device details, and an allowlisted redacted diagnostics export are
available from the application menus. State-changing commands use expected-state guards,
value readback, and dirty-state verification. Local `.qcw` workspace snapshots
can be saved and reopened without touching the hardware. Persistent device
Save As is available only through a separate destination review and final
confirmation; global-setting writes remain locked. The chat dock also executes
offline typed inspection/performance commands and previews bypass or parameter
edits before applying them temporarily. Windows installer builds embed the
Python gateway and its USB dependencies, so an installed app does not require
Python, Node, Rust, the source tree, or a repository `.venv` at runtime.
Push-to-talk voice transcription is runtime-detected and opt-in: the app
discloses that stable Microsoft Edge speech recognition may send microphone
audio to Microsoft Azure before starting it, then routes the visible transcript
through the same guarded typed-command path.

The USB transport has been validated locally against a connected Quad Cortex using `pyquadcortex`.

## Licensing

No project license has been selected yet. Until one is added, the source is not offered under an open-source license. Third-party dependencies retain their own licenses; release builds will include generated third-party notices.
