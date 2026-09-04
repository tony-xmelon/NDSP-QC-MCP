# Architecture

## Goal

Support Windows now and Android, iOS, web, automation, and other clients later while maintaining one tested implementation of Quad Cortex behavior. The architecture follows ports and adapters: stable device concepts and application use cases sit in the center; USB, IPC, network, UI, MCP, voice, storage, and operating-system integrations sit at the edges.

## System map

```text
 Windows React shell ─┐                           ┌─ Tauri adapter ── Rust device broker ─┐
                      ├─ qc-ui + qc-core + client ┤                                      ├─ qc-device-runtime + qc-protocol ── USB-HID ── QC
 Android React shell ─┘                           └─ Capacitor adapter ── Java/JNI host ──┘

 ChatGPT / Claude ── HTTPS OAuth + Streamable MCP ── Rust remote service ─┬─ paired Windows outbound client ── Rust broker ──┐
                                                                         └─ paired Android foreground relay ── Java/JNI host ─┴─ USB-HID ── QC
 MCP gateway mode ── gateway.v1 ── Rust device broker
```

The Windows native broker, Android direct adapter, and direct MCP mode are alternative QC owners. They must not open the hardware simultaneously.

## Modules and dependency rules

### Python parity packages

`services/device-gateway` and `pyquadcortex` are retained only as a source-level
differential oracle and protocol reference. They are not packaged in Windows or
Android and are never selected by default. `QC_GATEWAY_RUNTIME=python` is an
explicit development-only parity mode.

### `services/device-broker` and `packages/rust/qc-device-runtime`

The Rust broker is the Windows composition root and exclusive device-session
owner. It exposes framed `gateway.v1` over stdio, owns Windows HID and event
correlation, and delegates platform-neutral snapshot/preset-library behavior to
`qc-device-runtime` and all wire semantics to `qc-protocol`.

The Python device gateway is the parity oracle, not a deployed composition root.

### MCP and remote services

The legacy Python MCP package is retained as a local compatibility oracle. New public
connector deployments use three Rust services:

- `services/rust-mcp` owns the `rmcp` tool/resource surface and per-request
  principal/device route requirement.
- `services/qc-relay` owns OAuth resource metadata, bearer authorization,
  pairing, revocation, rate limits, active-device routing, and the outbound
  `qc-relay.v1` WebSocket protocol.
- `services/qc-remote` composes both Axum routers, validates external OAuth
  tokens through introspection, and is the HTTPS reverse-proxy deployment target.

Local gateway mode reaches the same Rust device broker contract used by the
Windows client. Remote mode reaches either a paired Windows broker or the paired
Android native host through an authenticated outbound relay connection; neither
deployed path loads Python or pyquadcortex.

`packages/rust/qc-relay-protocol` owns the shared relay wire frames and limits.
`packages/rust/qc-relay-client` owns the reusable outbound Rust client used by
Windows. The complete 46-method action allowlist and minimum access tier for
Windows, Android, and the server are generated from `qc-actions.v1.json`. A
contract test requires it to remain an exact gateway-method set, so a new
Windows RPC cannot silently be omitted from Android.

The public server is only an OAuth resource server. Identity remains with a
configured OAuth 2.1 authorization server supporting S256 PKCE. Exact issuer,
resource/audience, expiry, and scope are checked on every request. No provider
consumer token, browser cookie, HID frame, protobuf payload, or arbitrary RPC is
accepted by the remote boundary.

### `packages/python/qc-gateway-client`

Provides a Python implementation of the versioned gateway contract. It is used by gateway-mode MCP and future Python integrations, not by `qc-core`.

### `contracts`

Contains versioned, language-neutral schemas for commands, results, snapshots, events, errors, capabilities, confirmation requests, and protocol negotiation. JSON Schema is the initial interchange definition. Generated Python/TypeScript/Kotlin/Swift models are build artifacts and are never hand-edited.

Five manifests currently prevent platform drift:

- `qc-usb-profile.v1.json` owns USB identity, handshake/sync timing, subscriptions, frame limits, keepalive policy, and performance MIDI mappings.
- `qc-domain.v1.json` owns Grid/scene/tempo limits, scene colors, route IDs/labels/groups, and IPC frame limits.
- `gateway-methods.v1.json` owns every gateway RPC, TypeScript client method,
  Tauri command binding, generated Android dispatch class, and the identical
  46-method set supported by the legacy Python parity runtime. Python delegates
  device identity/history and screenshot/remote-screen behavior to pyquadcortex.
- `qc-actions.v1.json` owns the cross-surface assistant/MCP action names, RPC mapping, descriptions, schemas, and read/live/persistent safety class.
- `qc-payloads.v1.schema.json` owns snapshots, native state events, Grid/editor structures, and action results generated for TypeScript, Rust, and Python.

`npm run protocol:generate` materializes the required Rust, Java, Python, TypeScript, JSON Schema, and Tauri binding files. `npm run protocol:check` fails when a checked-in generated file drifts from its manifest.

Each request carries a protocol version, request ID, command kind, payload, and optional expected-state guard. Errors use stable codes plus human-readable detail. Capability negotiation lets old clients hide unsupported features safely.

### TypeScript packages

- `qc-core` owns shared Windows/Android behavior: the gateway-backed device transport adapter, realtime command coordinator, optimistic state and rollback, stale-echo reconciliation, surface commands, routing taxonomy and constraints, editor transitions, tempo, footswitch semantics, assistant action validation and device-command resolution. It imports no React, browser, Tauri, Capacitor, or native USB APIs.
- `qc-client` owns generated TypeScript types and the stable `gateway.v1` transport contract.
- `qc-ui` owns reusable web components for the QC screen and controls plus React bindings for the core parameter-editor and realtime device-command sessions. `useQcController` keeps native-frame commits synchronous with the current snapshot, serializes rapid adjacent-preset requests, and runs the same optimistic send/readback/rollback transaction for every platform, including assistant-initiated performance commands, but imports no Tauri or Capacitor APIs.
- `qc-form-factors` owns declarative geometry and skins. Manifests refer to semantic controls such as `footswitch:A`, not backend methods.

Realtime native adapters timestamp observations at the device boundary and
batch all updates decoded from one device frame. A single Rust engine in
`packages/rust/qc-protocol` owns HID framing and receive-frame assembly,
handshake/initialization messages, intent-level outbound device commands,
protobuf state normalization, and complete ModelRepo
parameter/display semantics. Windows links it directly into the native broker;
Android reaches it through a narrow JNI facade. `qc-core` owns pending-command
reconciliation, command transactions, batch reduction, and the provider-neutral
bounded chat/tool-loop controller, so both clients share wire interpretation,
ordering, editor metadata, routing rules, and stale-echo behavior while retaining only the
platform-specific USB handle, permission, endpoint, and lifecycle code. HID
reads, writes, performance MIDI, and ModelRepo parsing use independent lanes.
Both native hosts retain the USB handle for the full connected session and
  expose the same 67 gateway methods. Their remaining native code is limited to
OS permission/interface discovery, endpoint I/O, serialized scheduling,
lifecycle adaptation, and notifications. Shared Rust owns tempo-clock decoding,
backup chunk assembly and validation, command planning, HID-versus-MIDI lane
selection, and response projection.

Cross-native transport policy lives in `contracts/qc-usb-profile.v1.json` and
generates Java/Rust constants. Runtime reconnect cadence, handshake attempts,
keepalive scheduling, outbound-idle tracking, and read-error tolerance live in
`qc-protocol::session::SessionMachine`, called by both native hosts. Native
adapters may differ in OS lifecycle and endpoint APIs, but they do not
independently choose session policy, handshake versions, subscriptions, frame
limits, keepalive timing, or performance MIDI mappings.

The Windows app composes these packages with Tauri. A future React Native client may reuse `qc-client` and manifests without being forced to reuse DOM components. Native Kotlin/Swift clients can instead generate models from the same contracts.

### Client apps

Each directory under `apps/` is a thin composition root for navigation, lifecycle, platform permissions, credential storage, networking, notifications, audio, and packaging. Client apps do not contain QC command rules or USB protocol code.

Client apps also never import one another. Shared React controls, styling, editor state, and the verified command journal belong in `qc-ui`; shared behavior, chat sessions, route drafts, and preview fixtures belong in `qc-core`. Platform-only composition such as the Windows routing editor and chat dock lives in focused components rather than the application root. This prevents a desktop-only stylesheet or compatibility wrapper from becoming an accidental mobile dependency.

## Command flow

1. A client creates a typed command with an expected device/preset/scene revision.
2. The gateway validates protocol version, capabilities, authorization, and confirmation level.
3. `qc-core` validates domain invariants and serializes the mutation.
4. `DevicePort` executes through the selected adapter.
5. The owner waits for a device event or performs delayed readback.
6. It publishes the authoritative result and journal entry to every subscribed client.

An interrupted or uncertain mutation is never blindly replayed. The owner reads device state first and reports whether it landed.

Windows and Android persist a local assistant access mode that defaults to full
guarded control. The cumulative tiers are **Read-only** for inspection;
**Performance** for buttons, views, master volume, and tempo; **Modify** for
those operations plus Grid, preset, scene, routing, and save edits; and **Full
control** for all of those plus system-level operations. Both native outbound
relay adapters enforce the generated tier for every remote request, so changing
or bypassing web UI state cannot authorize a broader operation. Manual app
controls remain independent.

## Device ownership and deployment modes

| Scenario | QC owner | Client path |
|---|---|---|
| Windows desktop only | bundled gateway sidecar | private stdio JSON-RPC |
| Windows through public MCP | Windows Rust broker | paired outbound `wss://` relay |
| Android through public MCP | Android native USB host | paired foreground `wss://` relay |
| Headless computer/Raspberry Pi | gateway service | authenticated network API |
| Standalone MCP, desktop closed | MCP direct mode | MCP to core/device adapter |
| MCP while desktop owns QC | Windows gateway | MCP gateway mode |

The UI always displays the active ownership mode and can diagnose a lock held by Cortex Control or another project process.

## Repository enforcement

CI will enforce these boundaries with import rules, contract compatibility tests, and separate builds for each publishable module. A change to a contract must include versioning/compatibility coverage. Real-hardware mutation tests use only a configured scratch preset and are excluded from ordinary CI.

## Decisions deliberately deferred

- Native Kotlin/Swift versus a cross-platform mobile UI framework.
- Exact LAN discovery and pairing mechanism.
- MCP direct mode as a default or optional install extra.
- Monorepo task runner and package publishing registry.
- Public project license and trademark-approved visual assets.

These choices do not alter the core dependency direction.
