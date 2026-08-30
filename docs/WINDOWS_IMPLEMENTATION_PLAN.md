# QC Voice Control — Windows implementation plan

## 1. Product definition

Build a Windows desktop controller for the large-form-factor Neural DSP Quad Cortex. The application mirrors the physical unit closely enough that a user can transfer muscle memory between hardware and software, while adding desktop menus, connection diagnostics, keyboard/mouse control, and an AI chat/voice surface.

The first supported hardware profile is the original large Quad Cortex. Form-factor geometry and visual styling must be data-driven so future profiles—such as Quad Cortex Mini, a compact desktop layout, or accessibility-focused layouts—do not require changes to device-control logic.

### Product principles

1. **Hardware-familiar:** The Grid, footswitches, labels, modes, colors, and press/hold behavior should feel like the physical unit.
2. **State-truthful:** The screen represents state read from the QC, not an optimistic local shadow. Writes are verified by readback where the protocol permits it.
3. **Safe by default:** Performance actions may execute immediately; persistent or global changes use previews, explicit save semantics, and confirmation proportional to risk.
4. **Usable without AI:** Device control, menus, keyboard/mouse mappings, diagnostics, and preset inspection continue to work when voice or cloud services are unavailable.
5. **Extensible presentation:** Device behavior, form-factor geometry, and visual themes are separate layers.
6. **Single device owner:** Exactly one backend session owns the QC HID interface. UI, chat, voice, and automation all submit commands through that session.

## 2. Recommended technical architecture

This Windows plan is one client plan within the repository-wide architecture in [ARCHITECTURE.md](ARCHITECTURE.md). The desktop application must remain a thin platform composition root; device behavior belongs to reusable packages and services.

### Desktop stack

- **Tauri 2** for the Windows application shell, native menus, installer, window management, and sidecar lifecycle.
- **React + TypeScript + Vite** for the hardware surface, QC screen, chat UI, dialogs, input handling, and skin renderer.
- **Python 3.13 device-gateway sidecar** for exclusive USB-HID ownership, state normalization, command validation, and diagnostics. It composes the reusable `qc-core` and `qc-pyquadcortex` packages.
- **PyInstaller/Nuitka packaging spike** to produce a self-contained Python sidecar. Select the packager after verifying `protobuf` and the Windows `hidapi` binding in a clean VM.
- **WebView2** as the Windows web runtime used by Tauri. Validate microphone permission and Realtime WebRTC in the first technical spike rather than postponing it.

This split keeps the proven Python hardware implementation intact while giving the UI the precision and flexibility needed to recreate the hardware surface. The frontend must never call `pyquadcortex` directly. AI/MCP is not part of the desktop boundary: the standalone MCP service uses the same core either directly or through the gateway.

### Process boundary

Use framed JSON-RPC over the sidecar's stdin/stdout for the installed desktop app. This avoids opening a localhost port and makes process ownership explicit.

The backend publishes:

- state snapshots;
- incremental device events;
- connection-state changes;
- command progress and readback results;
- tool-call previews and confirmation requirements;
- diagnostic events suitable for a user-visible log.

An optional authenticated HTTP/WebSocket transport may be enabled later for Android, iOS, web, or headless clients. It wraps the same application service rather than becoming a second hardware-control implementation and is disabled by default.

### Repository modules used by Windows

```text
packages/python/qc-core/             Models, ports, commands, safety, history
packages/python/qc-pyquadcortex/     USB-HID/protocol adapter
services/device-gateway/             Sidecar entry point, IPC, session lifecycle
contracts/                           Versioned cross-language wire schemas
packages/typescript/qc-client/       Generated types, transport, shared state
packages/typescript/qc-ui/           Reusable web UI primitives
packages/typescript/qc-form-factors/ Geometry and skins
apps/windows/                        Tauri composition root and Windows adapters
```

### Frontend modules

```text
apps/windows/src/
  app-shell/                Window chrome, menus, dialogs, notifications
  device-session/           Connection store and backend event client
  platform/                 Tauri menus, credentials, audio, files, sidecar
  qc-screen/                Grid, Directory, parameter editor, utility views
  hardware-controls/        Footswitch/encoder press, hold, rotate, LED behavior
  input/                    Keyboard, mouse, focus, shortcuts, remapping
  chat/                     Conversation, composer, tool previews, voice
  settings/                 Preferences, keymaps, audio, privacy
```

Form factors and skins are imported from `packages/typescript/qc-form-factors`; generic screen/control components come from `packages/typescript/qc-ui`. Windows-specific code stays under `apps/windows`.

## 3. UI composition

### Application shell

From top to bottom:

1. Native title bar or integrated Tauri title bar.
2. Application menu bar.
3. Connection/form-factor toolbar.
4. Scalable hardware surface.
5. Docked chat and voice composer.
6. Optional transient status/toast layer.

The hardware should remain the visual center. Chat is docked below it and may be collapsed or resized, but it must not cover hardware controls.

### Menu model

#### File

- Open Workspace…
- Open Device Preset…
- Save Workspace
- Save Workspace As…
- Save Preset to Quad Cortex…
- Recent Workspaces
- Settings…
- Exit

`Save Workspace` and `Save Preset to Quad Cortex` are deliberately distinct. A workspace is a local `.qcw` document containing the source preset identity, normalized snapshot, proposed/applied edits, UI state, and conversation references. Applying a workspace to hardware must generate verified sparse writes; sending an entire stored `BinaryPreset` is not a valid restore mechanism.

#### Edit

- Undo Last App Change
- Redo
- Copy Selected Block Settings
- Paste Block Settings
- Select All Scene Values
- Keyboard Shortcuts…

Undo/redo initially covers commands made through this application. It must not claim to undo independent touchscreen changes unless the before-state is known and still matches.

#### View

- Fit Hardware to Window
- Actual Size
- Zoom In / Out / Reset
- Full Screen
- Show/Hide Chat
- Show Connection Log
- Form Factor
- Skin
- Developer Overlay (development builds only)

#### Device

- Connect / Disconnect
- Reconnect
- Reset Communication Session
- Rescan USB Devices
- Refresh Complete State
- Current Device Information
- Open Tuner
- Open Gig View
- Export Diagnostics…

“Reset Communication Session” closes and reopens the application’s HID session and repeats the handshake. It must never mean reboot, factory reset, or erase data.

#### Help

- User Guide
- Keyboard and Mouse Reference
- Report a Problem / Send Feedback…
- About QC Voice Control
- Third-Party Notices
- Privacy
- Legal Notices

Feedback submission is opt-in. The preview shows all attached diagnostics and redacts serial numbers, MAC addresses, usernames, paths, preset authors, and conversation content unless individually included by the user.

## 4. Hardware surface and form-factor system

### Large Quad Cortex profile

The initial form factor contains:

- the physical chassis aspect ratio;
- the QC touchscreen at its corresponding position;
- footswitch/rotary controls A–H;
- Bank Down, Bank Up, and Tempo/Tuner controls;
- switch labels, rings, LEDs, pressed/held states, and encoder rotation;
- hardware branding area and preset/mode indicators;
- responsive scaling that preserves aspect ratio and hit-target geometry.

The screen renderer and hardware surface are separate. The screen owns Grid/Directory/dialog interaction. The hardware shell owns footswitches, encoders, rings, and physical gestures.

The large-QC reference implementation follows the official 29 × 19.5 cm top-panel proportions and current CorOS 4.1 Grid conventions: the Master Volume and power controls flank the 7-inch screen, A–D and E–H sit in two rows below it, and the screen shows two routing rows at a time with outlined device glyphs. Reference photography and manual screenshots are design inputs only; the app uses original CSS/vector rendering rather than bundled Neural DSP product artwork.

### Form-factor manifest

Each profile supplies data rather than application behavior:

```ts
interface FormFactorManifest {
  id: string;
  displayName: string;
  supportedDeviceTypes: string[];
  chassisAspectRatio: number;
  screenRect: NormalizedRect;
  controls: HardwareControlPlacement[];
  defaultSkinId: string;
  supportedScreenLayouts: string[];
  keymapPresetId: string;
}
```

Control placement uses normalized coordinates so it scales with the hardware surface. A control declares a semantic role (`footswitch:A`, `bank:down`, `tempo`) rather than a backend command.

### Skin definition

A skin supplies:

- chassis colors/materials;
- screen bezel and glass treatment;
- switch/encoder/ring assets;
- typography;
- active/bypassed/selected/disabled colors;
- optional high-contrast and reduced-motion variants.

Skin packages may not define hardware commands, execute code, or access files/network. Geometry belongs to the form factor; appearance belongs to the skin. This lets one form factor have multiple visual themes without duplicating layout.

Use original vector/CSS assets that evoke the physical layout. Do not redistribute Neural DSP artwork, fonts, logos, or trademarks unless permission and attribution requirements are established. Legal Notices records the unofficial nature of the app and all third-party licenses.

## 5. QC screen interaction

### Initial screens

1. Grid with four rows, eight slots, splits/mixers, inputs, and outputs.
2. Block parameter editor.
3. Scene selector and scene labels/colors.
4. Preset/setlist browser.
5. Tuner status/control, excluding unsupported live needle data.
6. Tempo/metronome controls.
7. Gig View.
8. Connection/compatibility overlay.

Unsupported or unverified controls must be visible only when they can be represented honestly. They are disabled with a concise reason rather than simulated.

### Mouse behavior

- Click a screen block to select/open it.
- Double-click an appropriate empty slot to open the device chooser.
- Drag blocks only after the backend confirms the destination is valid; show a proposed destination before committing.
- Mouse wheel over an encoder adjusts its value.
- Vertical drag is the primary encoder gesture; horizontal drag may be an optional preference.
- Shift modifies encoder movement for fine adjustment.
- Right-click opens a context menu for supported operations.
- Hardware footswitches receive pointer-down/pointer-up events so press, hold, and release semantics remain distinguishable.

### Keyboard behavior

Default bindings are remappable and suspended while a text field owns focus unless marked global.

- `1`–`8`: activate hardware controls A–H in the current mode.
- `Ctrl+1`–`Ctrl+8`: directly select scenes A–H.
- Arrow keys: move screen selection.
- `Enter`: open/activate the selected screen item.
- `Space`: press/release the selected hardware control.
- `B`: toggle selected block bypass when supported.
- `Delete`: request removal of the selected block, with confirmation when persistent.
- `[` / `]`: Bank Down / Bank Up.
- `T`: tap tempo.
- `Shift+T`: tuner.
- `Ctrl+S`: save workspace; never silently save to the hardware.
- `Ctrl+Shift+S`: Save Preset to Quad Cortex dialog.
- `Ctrl+L`: focus chat.
- Configurable global push-to-talk shortcut, disabled by default until the user opts in.
- `Escape`: cancel current gesture/dialog or stop voice capture.

All interactive elements remain reachable through normal tab order and expose accessible names/state.

## 6. Connection and synchronization

### Connection state machine

```text
DISCONNECTED
  → DISCOVERING
  → OPENING
  → HANDSHAKING
  → SYNCING
  → READY

READY → DEGRADED → RECONNECTING → SYNCING → READY
                    ↘ INCOMPATIBLE
                    ↘ NEEDS_ATTENTION
```

Definitions:

- **Disconnected:** No selected device or user disconnected intentionally.
- **Discovering:** Enumerating matching USB interfaces.
- **Opening:** Claiming the control HID interface.
- **Handshaking:** Establishing the Cortex Control-compatible session.
- **Syncing:** Loading identity, current preset, catalog, scene, modes, settings, and subscribed state.
- **Ready:** State is current and commands are allowed.
- **Degraded:** Reads or pushes are delayed; safe queries remain available, mutations pause.
- **Reconnecting:** The session is being closed and rebuilt.
- **Incompatible:** Firmware/protocol behavior failed compatibility checks.
- **Needs attention:** Interface is locked, device permission failed, cable detached, or repeated retry failed.

### Recovery controls

The toolbar always shows connection state and last successful sync time. When a problem occurs it offers, as appropriate:

- Retry;
- Reconnect;
- Reset Communication Session;
- Rescan USB;
- Close Cortex Control and Retry;
- Refresh State;
- Copy Error Details;
- Export Diagnostics.

Automatic reconnect uses bounded exponential backoff and stops after repeated failure. Manual reconnect is always available. Mutating commands are never replayed automatically after an uncertain disconnect; the backend first reads state and decides whether the prior operation landed.

### State synchronization rules

- One serialized command queue owns all hardware mutations.
- Every command receives a unique app command ID and audit entry.
- Sparse writes are used for Grid edits.
- Expected active preset, active scene, row/column, model ID, and prior parameter value are checked before a write.
- After a write, wait for the relevant push or perform delayed readback to avoid stale immediate reads.
- Touchscreen changes are treated as authoritative external events and update the UI.
- If local pending work conflicts with a touchscreen change, stop and show a merge/reload choice.

## 7. Chat and voice

### Chat surface

The bottom composer follows a familiar conversational pattern without copying ChatGPT branding or proprietary assets:

- multiline message field;
- attach/context button for choosing current block, scene, preset, or diagnostics;
- microphone/push-to-talk button;
- send/stop button;
- collapsible conversation history above the composer;
- tool/action cards showing proposed and completed device operations;
- persistent context line showing device, preset, scene, dirty state, and connection quality.

The user may resize or collapse the chat dock. Hardware status and emergency cancellation remain visible while chat is expanded.

### Voice modes

1. **Push to talk (default):** Lowest accidental-command risk.
2. **Conversation mode:** Optional continuous voice activity detection.
3. **Dictation only:** Speech fills the composer but never sends automatically.

OpenAI Realtime runs over WebRTC in WebView2. The Python backend creates short-lived client credentials and retains the permanent API key in Windows Credential Manager. Microphone selection, mute, input meter, echo cancellation, transcript visibility, and data-retention disclosure live in Settings.

### AI tool design

Queries:

- inspect current preset/grid/block/scene;
- list/search installed models, presets, captures, and IRs;
- explain routing and parameter values;
- report device/connection state.

Performance actions:

- select scene;
- recall preset;
- open tuner/Gig View;
- press a mapped switch.

Edits:

- set parameter or bypass;
- place/remove/move a block;
- change routing;
- edit scenes;
- adjust global settings;
- save to a selected hardware slot.

The model never emits raw protobuf or arbitrary row/column writes. It calls typed domain tools with validated units and receives normalized results.

### Confirmation policy

- Immediate: read-only queries, scene selection, tuner/Gig View, and user-configured performance actions.
- Preview then apply: block parameter edits, bypass, block placement/removal/move, routing, and multi-step tone changes.
- Explicit confirmation: Save to device, overwrite/delete, setlist mutation, global I/O, phantom power, master volume, Global EQ, and bulk operations.

Every multi-step AI edit presents a diff grouped by scene and block. “Apply temporarily” changes the live grid without saving. “Save As…” chooses a destination slot and name.

## 8. Persistence and security

- Store settings/keymaps/form-factor choice in versioned JSON.
- Store workspaces, conversation metadata, normalized snapshots, and command journal in SQLite or a documented `.qcw` archive.
- Store API credentials only in Windows Credential Manager.
- Bind no network listener in the desktop-only configuration.
- Redact hardware serial/MAC, Windows username, paths, and account identifiers from logs by default.
- Keep local device control functional when signed out or offline.
- Make analytics and feedback attachments opt-in.
- Sign release binaries and publish checksums.

## 9. Delivery phases

### Phase 0 — technical foundation

- Scaffold Tauri, React/TypeScript, and Python sidecar.
- Implement framed JSON-RPC and sidecar lifecycle.
- Package `pyquadcortex` with the working Windows `hidapi` binding.
- Spike WebView2 microphone permission and Realtime WebRTC.
- Establish logging, redaction, tests, and CI.

Exit: packaged development build opens, starts/stops its sidecar, and can enumerate the connected QC without a console window.

### Phase 1 — connection and read-only state

- Implement connection state machine and recovery UI.
- Read identity, firmware, current preset, active scene, Grid, catalog, routing, bypass, and parameters.
- Normalize backend state and stream it to the frontend.
- Detect Cortex Control/interface lock.

Exit: unplug/replug and manual reconnect recover without restarting the app; no device data is mutated.

### Phase 2 — hardware-faithful UI

- Implement form-factor and skin contracts.
- Build the large QC chassis, screen rectangle, A–H, bank, and tempo controls.
- Render the live Grid and selected-block parameter editor.
- Add zoom/fit/full-screen and high-contrast support.
- Add visual regression tests.

Exit: the current preset, scene, routing, blocks, bypass, and core parameters match the physical QC after touchscreen changes.

### Phase 3 — mouse, keyboard, and safe performance control

- Implement pointer press/release/hold and encoder gestures.
- Add keyboard navigation, shortcuts, and remapping.
- Enable scene, preset, tuner, Gig View, and safe parameter operations.
- Add serialization, expected-state guards, readback, and audit history.

Exit: scene A→B→A, parameter edit/revert, and disconnect-during-command tests complete with known final state and no silent replay.

### Phase 4 — workspaces and persistent editing

- Implement local `.qcw` workspace documents.
- Add proposed diffs, temporary apply, revert, Save As to device, overwrite confirmation, and conflict handling.
- Implement supported Grid, routing, scene, and assignment edits.

Exit: a tone can be edited, reviewed, applied temporarily, saved to a new slot, recalled, and verified against the intended diff.

### Phase 5 — text chat

- Add conversation dock and typed QC tools.
- Build current-context summaries from normalized device state.
- Add tool cards, confirmation flow, cancellation, and error recovery.
- Ensure device functions still work without AI configuration.

Exit: text requests can inspect a preset, propose a scene-specific change, apply it temporarily, and save only after confirmation.

### Phase 6 — voice

- Add push-to-talk, transcript, interruption, stop/cancel, audio settings, and short-lived credentials.
- Add optional conversation and dictation-only modes.
- Test ambiguous commands, background noise, disconnects, and mid-speech cancellation.

Exit: voice can safely inspect and control the QC with visible transcripts and the same confirmation policy as text.

### Phase 7 — productization and additional form factors

- Complete menus, Settings, About, privacy/legal, third-party notices, feedback, diagnostics export, updater, signing, and installer.
- Add a second deliberately different form factor to prove the abstraction.
- Run clean-machine, Windows scaling, accessibility, and long-session tests.

Exit: signed installer passes clean Windows 10/11 verification and a second form factor can be added without backend changes.

## 10. Test strategy

- Reuse `pyquadcortex` fake-transport and offline protocol fixtures.
- Backend unit tests for every typed command, validation rule, confirmation level, and redaction rule.
- Contract tests for JSON-RPC schemas and version negotiation.
- Frontend component tests for every screen/control state.
- Golden-image tests at 100%, 125%, 150%, and 200% Windows scaling.
- Keyboard-only and screen-reader passes.
- Fault injection: cable removal, locked HID interface, stale read, dropped push, slow catalog, sidecar crash, incompatible firmware, and app shutdown during a command.
- Real-hardware smoke suite with only a designated scratch preset slot for persistent writes.
- Voice tests with mocked tool calls before any live-device execution.
- Clean VM installer/uninstaller tests with no preinstalled Python, Rust, Node, or developer tools.

## 11. MVP acceptance criteria

The first public MVP is complete when it can:

1. Install on a clean Windows 10/11 x64 system.
2. Detect, connect, sync, disconnect, and reconnect the large QC.
3. Show the actual current preset, scene, Grid, routing, bypass, and core parameter values.
4. Reproduce A–H, Bank, Tempo/Tuner, screen selection, and encoder interactions with mouse and keyboard.
5. Apply supported temporary changes with expected-state validation and readback.
6. Keep workspace save and hardware save unmistakably separate.
7. Provide text chat and push-to-talk voice with visible tool previews and confirmation.
8. Recover safely from cable removal or backend failure without replaying uncertain writes.
9. Export a redacted diagnostic bundle.
10. Load the large-QC form factor and skin through the extension contracts rather than hard-coded layout logic.

## 12. Early decisions that remain reversible

- Tauri versus a pure WinUI/WebView2 shell if microphone or accessibility integration proves unreliable.
- PyInstaller versus Nuitka for sidecar packaging.
- OpenAI Realtime as the initial voice provider versus an optional local recognizer later.
- SQLite-backed workspaces versus a portable zipped `.qcw` document.
- Exact save/overwrite workflow after observing how users combine touchscreen and desktop editing.

None of these decisions changes the normalized device model, typed command layer, form-factor manifest, skin contract, or confirmation policy.
