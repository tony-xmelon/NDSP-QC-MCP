# Windows client

Tauri 2 desktop composition root for the large Quad Cortex surface, application menus, keyboard/mouse input, chat, voice capture, settings, and gateway sidecar lifecycle.

Allowed dependencies: TypeScript client/UI/form-factor packages and platform adapters. It must not import `pyquadcortex`, implement device rules, or define cross-process contracts.

## Current slice

- scalable large-QC chassis, screen grid, A–H encoders/footswitches, bank and tempo controls;
- scene selection, block selection/bypass, tempo rotation, and keyboard shortcuts;
- File/Edit/View/Device/Help menus and Settings/About/connection dialogs;
- connection state and safe reconnect/reset failure behavior;
- docked chat composer and microphone permission/capture lifecycle;
- Obsidian and high-contrast skins loaded through shared manifests;
- deterministic, clearly marked demo state for UI development.

Device writes are intentionally locked until `services/device-gateway` is attached. Chat messages remain local until an assistant transport is configured.

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
