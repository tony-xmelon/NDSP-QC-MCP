# Conversational chat and MCP

QC Control has two separate AI-facing integrations. They share the same guarded
device operations, but they serve different hosts:

- The Windows chat uses a native provider bridge inside the Tauri application.
  It supports OpenAI Responses-compatible endpoints, Google Gemini through
  Google OAuth or BYOK, Anthropic through its native Messages API, and keyless
  local Responses servers. Provider and credential policy is documented in
  [MODEL_PROVIDERS.md](MODEL_PROVIDERS.md).
- The standalone MCP server supplies QC resources and tools to any MCP host.

Neither path permits arbitrary HID, protobuf, or JSON-RPC. Global-setting
writes are exposed only as typed, allowlisted actions with the same explicit
persistent-write confirmation and device readback rules as other mutations.

## Windows conversational chat

Open **Settings → Conversational model** to select the provider, model, API base
URL, and timeout. Non-secret settings are stored under the current user's local
application-data directory. A provider key can be saved from this screen into a
provider-specific Windows Credential Manager entry; it is never returned to the
web interface or written to settings/local storage after submission.

Environment configuration remains supported: for the default OpenAI endpoint,
start QC Control with either `QC_OPENAI_API_KEY` or `OPENAI_API_KEY` present in
its process environment. The general `OPENAI_API_KEY` is sent only to
`api.openai.com`; a custom remote provider requires `QC_OPENAI_API_KEY`. A key
stored in Windows Credential Manager takes precedence for its exact provider
base URL. Remote endpoints must use HTTPS.

For Gemini, select **Google Gemini (BYOK)**, create a key in Google AI Studio,
and save it in the credential editor. The fixed Google endpoint uses Chat
Completions and function calling; `QC_GEMINI_API_KEY` and `GEMINI_API_KEY` are
also supported as environment fallbacks.

An OpenAI Responses-compatible loopback endpoint can use a URL such as
`http://127.0.0.1:11434/v1` without a key. The local server must implement the
`POST /v1/responses` contract, including function tools if QC actions are wanted.

Before the first remote-model request, the app discloses that conversation text
and current QC context will be sent to the configured provider. That consent can
be cleared in Settings. Manual controls and recognized offline commands continue
to operate without a model.

The model receives a generated allowlist covering the complete gateway contract. Read-only requests may produce a
bounded second model call so the result is explained naturally. A turn can request
multiple ordered device actions in one request. The model can directly invoke
the same expected-state and readback-verified controls as the desktop UI,
including Grid/routing edits, performance controls, master volume, connection
recovery, backups, Save As, and current-preset rename. Persistent saves and
renames are used only when the user explicitly requests them.

Both client apps expose the same cumulative assistant/device access modes:

- **Read-only** permits inspection and no writes.
- **Performance** adds buttons, performance views, master volume, and tempo.
- **Modify** adds Grid, routing, preset, save, and scene operations, but not system operations.
- **Full control** permits every allowlisted operation.

Full control remains the default. Expected-state, readback, risky-operation, and
persistent-write confirmations still apply at every tier. The Windows and Android
native relay adapters enforce the selected tier independently of the web UI.
Manual app controls are unaffected.

## Standalone MCP server

The production mobile connector is now the Rust service in
`services/qc-remote`. ChatGPT or Claude connects to its public HTTPS Streamable
HTTP endpoint and performs OAuth directly with the configured authorization
server. The provider host then sends ordinary OAuth access tokens scoped to the
QC relay; QC Control never receives ChatGPT/Claude consumer login tokens,
browser cookies, or provider secrets. The app that owns USB opens an outbound
authenticated WebSocket to the relay: a background native task on Windows, or a
foreground service on Android. Neither app opens a public inbound listener.

Pair Windows from **Settings → Public MCP relay** using the HTTPS relay origin and
one-time pairing code. The returned device credential is stored in Windows
Credential Manager and the connection resumes automatically on later launches.
Android uses its Keystore-backed pairing flow. Unpairing deletes the local device
credential and stops reconnect attempts.

This lets a user use the model entitlement in their existing ChatGPT or Claude
subscription: inference stays in the provider's chat product, while the shared
connector only transports typed QC tool calls and results. Claude Mobile can use
a remote connector after it has been added to the account through Claude's web
connector settings.

The historical Python MCP package below remains operational as a local parity
oracle while the Rust surface is validated. It is deprecated for new public
deployments; do not delete it until release parity is complete.

From a source checkout, install the gateway client followed by the MCP package:

```powershell
python -m pip install -e packages/python/qc-gateway-client
python -m pip install -e services/mcp-server
python services/mcp-server/main.py --mode gateway --transport stdio
```

The installed entry point is `ndsp-qc-mcp`. It supports stdio and loopback
Streamable HTTP. See [the MCP service README](../services/mcp-server/README.md)
for command-line options and packaging.

Published resources are:

- `qc://status`
- `qc://current-preset`
- `qc://models`

The generated server surface contains all 102 actions in
`contracts/qc-actions.v1.json`: device and library reads; guarded performance,
Grid, routing, scene, parameter, I/O, global-setting, and library writes; and
persistent preset/backup operations. Persistent and risky actions require their
explicit confirmation flags. Preset rename overwrites only the active user
preset's current slot and verifies the returned name; factory presets remain
read-only.

Local gateway/direct modes each own the QC session used by that MCP process, so
close QC Control and Cortex Control before starting either mode. The supported
way for MCP to control a QC already owned by a running Windows or Android app is
the authenticated public relay described above; the private desktop child
process is intentionally not exposed for local process attachment.
