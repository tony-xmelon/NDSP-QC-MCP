# Windows client

Tauri 2 desktop composition root for the large Quad Cortex surface, application menus, keyboard/mouse input, chat, voice capture, settings, and gateway sidecar lifecycle.

Allowed dependencies: TypeScript client/UI/form-factor packages and platform adapters. It must not import `pyquadcortex`, implement device rules, or define cross-process contracts.

## Current slice

- scalable large-QC chassis, screen grid, A–H encoders/footswitches, bank and tempo controls;
- live scene selection, mode-aware A–H footswitches, guarded tempo/tap, block bypass and parameter editing, preset/setlist browsing, bank navigation, live input/output and split routing display, and keyboard shortcuts;
- local `.qcw` workspace save/open plus separately confirmed Quad Cortex preset Save As;
- File/Edit/View/Device/Help menus and Settings/About/connection dialogs;
- explicit disconnect, connection state/log, background synchronization of physical-device changes, safe reconnect/reset and sidecar-crash behavior, device details, and redacted diagnostics export;
- docked chat composer with offline typed inspection/performance commands, previewed temporary edits, and opt-in push-to-talk transcription;
- graphite-hardware and high-contrast skins loaded through shared manifests;
- deterministic demo state for browser-only UI development and automatic live hydration in Tauri.

The Tauri app launches `services/device-gateway`, which owns the QC session.
Device Save As requires destination review and a final confirmation, including
an explicit overwrite acknowledgement for occupied slots. Global settings remain
locked. The deterministic typed-command path works locally. When WebView2
exposes Microsoft Edge speech recognition, push-to-talk fills and submits that
same command path after an explicit cloud-audio disclosure; broad conversational
reasoning still requires a separately configured assistant transport.

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

That command packages `services/device-gateway` with PyInstaller, embeds the
target-triple sidecar in the Tauri bundle, and writes the installer under
`src-tauri/target/release/bundle/nsis`. The installed app resolves the gateway
beside its own executable; `QC_GATEWAY_EXECUTABLE` remains available for an
explicit test override, and source builds retain the repository `.venv` fallback.

Windows native builds use the MSVC Rust toolchain declared in `src-tauri/rust-toolchain.toml` and require the Visual Studio C++ Build Tools plus WebView2.
