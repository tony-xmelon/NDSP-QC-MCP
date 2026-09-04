# NDSP QC MCP

An unofficial, modular control platform for Neural DSP Quad Cortex devices. The project is intended to support a hardware-faithful Windows controller, a standalone MCP server, and future Android, iOS, web, and other clients without duplicating device-control logic.

> [!IMPORTANT]
> This project is not affiliated with or endorsed by Neural DSP. Device support uses an independent native Rust implementation informed by the community-maintained `pyquadcortex` project. The private protocol remains firmware-sensitive.

## Repository shape

```text
apps/                       End-user clients
  windows/                  Tauri + web UI desktop client
  android/                  Capacitor Android client with native USB, AI, and voice adapters
  ios/                      Future iOS composition root
services/                   Independently runnable processes
  device-broker/            Native single-owner USB/protobuf broker
  device-gateway/           Legacy Python parity gateway for development
  mcp-server/               Standalone MCP server
packages/
  rust/
    qc-protocol/             Shared QC framing, protobuf schema, and native state engine
    qc-android/              Narrow JNI binding for the shared native state engine
  python/
    qc-core/                Pure device model, use cases, ports, safety rules
    qc-pyquadcortex/        Development-only pyquadcortex parity adapter
    qc-gateway-client/      Client for a running device gateway
  typescript/
    qc-core/                Shared client behavior, commands, reducers, transport port
    qc-client/              Generated contracts and gateway transport types
    qc-ui/                  Platform-neutral web UI primitives
    qc-form-factors/        QC geometry, skins, and control manifests
contracts/                  Versioned wire schemas; the cross-language source of truth
docs/                       Product, architecture, and decision records
tests/                      Cross-module contract and real-hardware tests
```

Every directory initially contains a boundary document. Code is added only to the module that owns the responsibility.

## Architectural rules

- `qc-core` contains no HID, MCP, HTTP, UI, Tauri, or operating-system imports.
- Production device behavior lives in the shared Rust crates; `qc-pyquadcortex` isolates the optional Python parity oracle.
- Exactly one process owns the QC USB-HID session at a time.
- Clients communicate in typed domain commands and events, never protobuf packets or raw grid coordinates.
- `contracts/` is the source of truth for cross-process and cross-language messages.
- The MCP server is independently installable and never imports a desktop or mobile app.
- Form-factor geometry, skins, and behavior are separate; adding a client or skin must not change device logic.
- AI is an optional adapter. Manual device control continues to work without an AI provider.

See [Architecture](docs/ARCHITECTURE.md), the [Windows implementation plan](docs/WINDOWS_IMPLEMENTATION_PLAN.md),
and the [pyquadcortex coverage and deferred OpenCortex research](docs/PYQUADCORTEX_COVERAGE_AND_OPENCORTEX.md).

## Status

The Windows client now has a Tauri/WebView2 shell, reusable hardware surface,
form-factor/skin packages, keyboard/mouse interaction, connection diagnostics,
menus, chat composer, and microphone capture lifecycle. A native Rust broker
owns QC HID, exposes the complete application gateway API, keeps the session
warm, and publishes realtime state from the same Rust decoder compiled into
Android. The optional Python gateway is a development-only differential oracle.
One Rust session machine now owns reconnect,
handshake, keepalive, and link-loss policy for both native hosts, and shared
payload schemas generate the TypeScript, Rust, and Python boundary types.
Scene selection, block bypass, tuner, and
Gig View controls are enabled, along with mode-aware A–H footswitch emulation
through the QC's Windows MIDI endpoint and verified tempo/encoder/tap control,
live setlist browsing, installed model discovery, guarded block placement/removal/movement,
STOMP assignment and signal-routing editing, guarded preset
recall, bank navigation, metadata-driven block parameter editing, and explicit
dirty-state recovery. The Grid rails and split/rejoin markers are derived from
the live preset's four-row routing topology rather than demo labels, including
parallel-lane blocks and split/rejoin points. Visible device state synchronizes
in the background so touchscreen changes appear without a manual refresh.
Explicit disconnect/reconnect, a privacy-safe connection
log, current-device details, and an allowlisted redacted diagnostics export are
available from the application menus. State-changing commands use expected-state guards,
value readback, and dirty-state verification. Local `.qcw` workspace snapshots
can be saved and reopened without touching the hardware. Persistent preset,
library, and global-setting writes require explicit review and confirmation.
The chat dock now supports a
configurable OpenAI Responses-compatible conversational model, supplies current
QC context as untrusted data, and exposes an allowlisted set of typed device
tools. Read tools can be followed by a natural answer; performance actions
retain expected-state guards; bypass and parameter edits still require review
before temporary application. The deterministic offline command parser remains
available when no model is configured. Windows installer builds embed only the
native Rust device broker; Python and pyquadcortex remain source-level parity
tools and are not installed. The installer also embeds the
optional YouTube reference-audio resolver: after explicit rights confirmation,
chat can fetch a bounded excerpt as Opus/WebM or AAC/M4A, losslessly remux it,
attach it to the next model round, and remove the temporary file. An installed app does not require
Python, Node, Rust, the source tree, or a repository `.venv` at runtime.
Push-to-talk voice transcription is runtime-detected and opt-in: the app
discloses that stable Microsoft Edge speech recognition may send microphone
audio to Microsoft Azure before starting it, then routes the visible transcript
through the same guarded typed-command path.

The public MCP and remote-control services are implemented in Rust, with the
legacy Python server retained only as a compatibility oracle. Neither deployed
path exposes raw HID, protobuf, or arbitrary JSON-RPC; global-setting mutations
remain typed, allowlisted, and confirmation-gated.
See [Chat and MCP setup](docs/CHAT_AND_MCP.md).

The Android client is available as a branded Firebase App Distribution build.
It presents the QC display, compact performance controls, and chat in a
phone-first layout. Android owns a direct USB-host HID session with the Quad
Cortex (USB permission is requested on first attachment), uses Firebase AI
Logic with Gemini 3.7 Flash without embedding a personal Gemini key, and sends
Android speech-recognition transcripts through the same chat/action path. The
generated hardware-safe action allowlist is shared with Windows and covers the
contracted read, performance, edit, library, and confirmed system surface. Live USB messages populate the
preset grid, routes, scene metadata, setlist position, dirty state, and master
volume.
Firebase App Check uses Play Integrity, with
the distributed debug certificate registered and off-Play tester builds
explicitly allowed.

The native transport and legacy parity adapter have been validated locally
against a connected Quad Cortex. See [Native QC device broker](docs/NATIVE_BROKER.md).

## Licensing

No project license has been selected yet. Until one is added, the source is not offered under an open-source license. Third-party dependencies retain their own licenses; release builds will include generated third-party notices.
