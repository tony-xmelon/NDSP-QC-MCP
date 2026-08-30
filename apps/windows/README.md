# Windows client

Tauri 2 desktop composition root for the large Quad Cortex surface, application menus, keyboard/mouse input, chat, voice capture, settings, and gateway sidecar lifecycle.

Allowed dependencies: TypeScript client/UI/form-factor packages and platform adapters. It must not import `pyquadcortex`, implement device rules, or define cross-process contracts.

## Current slice

- scalable large-QC chassis, screen grid, A–H encoders/footswitches, bank and tempo controls;
- live scene selection, guarded block bypass and parameter editing, preset/setlist browsing, bank navigation, and keyboard shortcuts;
- local `.qcw` workspace save/open plus separately confirmed Quad Cortex preset Save As;
- File/Edit/View/Device/Help menus and Settings/About/connection dialogs;
- connection state and safe reconnect/reset failure behavior;
- docked chat composer with offline typed inspection/performance commands, previewed temporary edits, and microphone permission/capture lifecycle;
- graphite-hardware and high-contrast skins loaded through shared manifests;
- deterministic demo state for browser-only UI development and automatic live hydration in Tauri.

The Tauri app launches `services/device-gateway`, which owns the QC session.
Device Save As requires destination review and a final confirmation, including
an explicit overwrite acknowledgement for occupied slots. Global settings remain
locked. The deterministic typed-command path works locally; broad conversational
reasoning and voice transcription still require an assistant transport.

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

Windows native builds use the MSVC Rust toolchain declared in `src-tauri/rust-toolchain.toml` and require the Visual Studio C++ Build Tools plus WebView2.
