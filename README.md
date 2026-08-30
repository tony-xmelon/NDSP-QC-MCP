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

The first Windows client slice is implemented: Tauri/WebView2 shell, reusable hardware surface, form-factor/skin packages, demo QC state, keyboard/mouse interaction, connection diagnostics, menus, chat composer, and microphone capture lifecycle. Hardware commands remain locked until the persistent device gateway is connected.

The USB transport has been validated locally against a connected Quad Cortex using `pyquadcortex`.

## Licensing

No project license has been selected yet. Until one is added, the source is not offered under an open-source license. Third-party dependencies retain their own licenses; release builds will include generated third-party notices.
