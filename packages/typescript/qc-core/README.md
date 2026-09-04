# `@ndsp-qc/core`

Platform-neutral Quad Cortex application behavior shared by the Windows and Android clients.

This package owns state reconciliation, surface-action interpretation, tap-tempo calculation, parameter-editor state helpers, footswitch behavior, assistant action validation, and the common device transport contract. It must not import Tauri, Capacitor, browser globals, React, or native USB implementations.

Both clients now consume the package for snapshot reconciliation and preview mutations, surface-command interpretation, the reducer-backed effect-editor session, tap tempo, footswitch mode/LED behavior, assistant intent parsing/action validation, and the common device port. `qc-ui` supplies the React hook that binds the editor reducer to the shared parameter screen. Android implements `QcDeviceTransport` through its Capacitor adapter. Windows adapts the stable high-level `GatewayTransport` directly to the native Rust broker. HID framing and process lifecycle remain outside this package.

Client composition roots should contain only platform lifecycle, permissions, presentation state, and adapter wiring. Adding a QC behavior here requires a core test first so Android and Windows cannot silently diverge again.

Run the shared behavior tests with:

```powershell
npm run test:core
```
