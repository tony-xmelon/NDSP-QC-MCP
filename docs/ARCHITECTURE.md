# Architecture

## Goal

Support Windows now and Android, iOS, web, automation, and other clients later while maintaining one tested implementation of Quad Cortex behavior. The architecture follows ports and adapters: stable device concepts and application use cases sit in the center; USB, IPC, network, UI, MCP, voice, storage, and operating-system integrations sit at the edges.

## System map

```text
 Windows app ── private stdio IPC ─┐
 Android/iOS/web ─ HTTPS/WebSocket ├── Device Gateway ── qc-core ── DevicePort
 Other local clients ─ local IPC ──┘                         │
                                                            └── qc-pyquadcortex ── USB-HID ── QC

 MCP client ── MCP Server ──┬── gateway mode ── Device Gateway
                            └── direct mode ─── qc-core + qc-pyquadcortex ── QC
```

The gateway and direct MCP mode are alternative QC owners. They must not open the hardware simultaneously.

## Modules and dependency rules

### `packages/python/qc-core`

Owns normalized models, typed commands and queries, use cases, connection states, safety classification, expected-state checks, command journaling interfaces, and ports. It has no knowledge of `pyquadcortex`, transport framing, MCP, UI frameworks, or operating systems.

Examples of ports include `DevicePort`, `EventSink`, `WorkspaceStore`, `CredentialStore`, and `Clock`. Fake implementations support deterministic tests.

### `packages/python/qc-pyquadcortex`

Implements `DevicePort` using `pyquadcortex`, HID, and protobuf details. All firmware/protocol quirks and translation between raw data and normalized domain models live here. No client is allowed to import `pyquadcortex` directly.

### `services/device-gateway`

Is the normal composition root and exclusive USB owner. It combines the core with a device adapter, serializes mutations, publishes state/events, performs recovery, and exposes transports:

- framed JSON-RPC over stdin/stdout for the packaged Windows sidecar;
- optional authenticated loopback or LAN HTTP/WebSocket for mobile/web clients;
- an in-process test transport.

Transport adapters call the same application use cases. Network exposure is disabled by default and must add pairing, authentication, TLS where appropriate, origin checks, rate limiting, and explicit user consent.

### `services/mcp-server`

Is an independently packaged MCP server. It maps MCP tools/resources to typed core use cases and never accepts raw protobuf or arbitrary hardware writes. It supports:

- **direct mode:** owns USB by composing `qc-core` with `qc-pyquadcortex`;
- **gateway mode:** uses `qc-gateway-client` when the Windows app or gateway already owns USB.

The MCP package has its own entry point, dependency declaration, tests, README, and release artifact. It does not import anything from `apps/` and contains no OpenAI-specific business logic.

### `packages/python/qc-gateway-client`

Provides a Python implementation of the versioned gateway contract. It is used by gateway-mode MCP and future Python integrations, not by `qc-core`.

### `contracts`

Contains versioned, language-neutral schemas for commands, results, snapshots, events, errors, capabilities, confirmation requests, and protocol negotiation. JSON Schema is the initial interchange definition. Generated Python/TypeScript/Kotlin/Swift models are build artifacts and are never hand-edited.

Each request carries a protocol version, request ID, command kind, payload, and optional expected-state guard. Errors use stable codes plus human-readable detail. Capability negotiation lets old clients hide unsupported features safely.

### TypeScript packages

- `qc-client` owns generated TypeScript types, transport clients, caching, and platform-neutral state transitions.
- `qc-ui` owns reusable web components for the QC screen and controls, but no Tauri APIs.
- `qc-form-factors` owns declarative geometry and skins. Manifests refer to semantic controls such as `footswitch:A`, not backend methods.

The Windows app composes these packages with Tauri. A future React Native client may reuse `qc-client` and manifests without being forced to reuse DOM components. Native Kotlin/Swift clients can instead generate models from the same contracts.

### Client apps

Each directory under `apps/` is a thin composition root for navigation, lifecycle, platform permissions, credential storage, networking, notifications, audio, and packaging. Client apps do not contain QC command rules or USB protocol code.

## Command flow

1. A client creates a typed command with an expected device/preset/scene revision.
2. The gateway validates protocol version, capabilities, authorization, and confirmation level.
3. `qc-core` validates domain invariants and serializes the mutation.
4. `DevicePort` executes through the selected adapter.
5. The owner waits for a device event or performs delayed readback.
6. It publishes the authoritative result and journal entry to every subscribed client.

An interrupted or uncertain mutation is never blindly replayed. The owner reads device state first and reports whether it landed.

## Device ownership and deployment modes

| Scenario | QC owner | Client path |
|---|---|---|
| Windows desktop only | bundled gateway sidecar | private stdio JSON-RPC |
| Windows plus phone remote | Windows gateway | authenticated LAN WebSocket/HTTPS |
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
