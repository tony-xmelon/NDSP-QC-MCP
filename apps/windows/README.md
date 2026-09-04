# QC Control

Tauri 2 desktop composition root for the large Quad Cortex surface, application menus, keyboard/mouse input, chat, voice capture, settings, and gateway sidecar lifecycle.

Allowed dependencies: TypeScript client/UI/form-factor packages and platform adapters. It must not import `pyquadcortex`, implement device rules, or define cross-process contracts.

The same `@ndsp-qc/ui` screen and `@ndsp-qc/core` behavior package are used by
Android. Windows-specific code is limited to desktop lifecycle, menus,
workspace/credential integration, the conversational-model provider, and an
adapter from the stable `GatewayTransport` to the shared device port.

The shared packages also own the parameter-editor session, routing taxonomy and
draft transitions, command journal, realtime snapshot controller, optimistic
command acknowledgement/rollback, and preview metadata. Generated gateway
bindings replace repeated RPC/Tauri strings in the TypeScript, Rust, and Python
adapters. The desktop shell retains only Tauri lifecycle, advanced device
workflows, desktop menus, provider integration, and layout.

## Current slice

- scalable large-QC chassis, screen grid, A–H encoders/footswitches, bank and tempo controls;
- live scene selection, mode-aware A–H footswitches, guarded tempo/tap, block placement/removal/movement, STOMP assignment, block bypass and parameter editing, preset/setlist browsing, bank navigation, live input/output and split routing display/editing, and keyboard shortcuts;
- local `.qcw` workspace save/open plus separately confirmed Quad Cortex preset Save As;
- File/Edit/View/Device/Help menus and Settings/About/connection dialogs;
- explicit disconnect, connection state/log, background synchronization of physical-device changes, safe reconnect/reset and sidecar-crash behavior, device details, and redacted diagnostics export;
- docked conversational chat with an OpenAI Responses-compatible provider,
  strict QC tool schemas, offline command fallback, previewed temporary edits,
  cancellation, audio/video/file attachments, authorized lossless YouTube
  reference-audio excerpts, and opt-in push-to-talk transcription;
- a persisted four-tier assistant-access setting—Read-only, Performance, Modify,
  and Full control—that defaults to full guarded control without affecting manual controls;
- an outbound-only public MCP relay client that pairs over HTTPS, stores its
  device credential in Windows Credential Manager, reconnects with bounded
  backoff, and routes allowlisted calls through the existing Rust broker;
- device-model-selected geometry and appearance loaded through shared manifests;
- deterministic demo state for browser-only UI development and automatic live hydration in Tauri.

The Tauri app launches the bundled `qc-device-broker`, which provides the stable
high-level API and is the only process that opens QC HID. Shared snapshot,
validation, and operation-planning behavior comes from `qc-device-runtime`, and
wire behavior comes from `qc-protocol`; no Python process is installed or
launched. See [`docs/NATIVE_BROKER.md`](../../docs/NATIVE_BROKER.md).
Device Save As requires destination review and a final confirmation, including
an explicit overwrite acknowledgement for occupied slots. Global settings remain
locked. Model, provider URL, timeout, and provider status are configurable in
Settings. Provider keys can be stored under a provider-specific entry in Windows
Credential Manager, or supplied by the desktop process environment; they are
never stored in app settings or web storage. Remote chat requires a first-use data disclosure,
while keyless loopback model endpoints are supported. The deterministic
typed-command path continues to work locally. When WebView2
exposes Microsoft Edge speech recognition, push-to-talk fills and submits that
same chat path after a separate cloud-audio disclosure.

The public relay opens no listening port on Windows. **Full control** is the
default and still applies the MCP confirmation and expected-state gates. The
native relay client independently enforces Read-only, Performance, Modify, or
Full access before every broker call.

See [`docs/CHAT_AND_MCP.md`](../../docs/CHAT_AND_MCP.md) for model-provider and
standalone MCP configuration.

Hardware proportions and CorOS screen conventions are documented in [`docs/VISUAL_REFERENCES.md`](../../docs/VISUAL_REFERENCES.md).

## Run

From the repository root:

```powershell
npm install
npm run tauri:dev
```

For the webview UI alone:

```powershell
npm run dev:windows
```

### Application version

`apps/windows/package.json` is the source of truth for the desktop application
version. Before publishing an installer, increment it with
`npm run version:app:patch` (or `:minor` / `:major`). Use
`npm run version:app:set -- 1.2.3` for an explicit version. The version tool
synchronizes the Tauri/NSIS, Rust, lockfile, About-dialog, and diagnostics
metadata. Installer builds verify synchronization automatically.

Build and validation:

```powershell
npm run typecheck
npm run build:windows
cd apps/windows/src-tauri
cargo check
```

Build the self-contained x64 NSIS installer from the repository root:

```powershell
npm run build:installer
```

That command builds the native Rust device broker, embeds its target-triple
sidecar in the Tauri bundle, and writes the installer under
`src-tauri/target/release/bundle/nsis`. The installed app resolves the gateway
beside its own executable; `QC_GATEWAY_EXECUTABLE` remains available for an
explicit test override. Source builds can select the repository `.venv` parity
gateway only by setting `QC_GATEWAY_RUNTIME=python`.

Windows native builds use the MSVC Rust toolchain declared in `src-tauri/rust-toolchain.toml` and require the Visual Studio C++ Build Tools plus WebView2.
