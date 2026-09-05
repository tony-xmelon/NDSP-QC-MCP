# Standalone MCP server

> Deprecated for new public deployments. This Python package remains supported
> as the local compatibility oracle until Rust release parity is complete. Use
> `services/qc-remote` for authenticated ChatGPT/Claude mobile connectivity.

An independently installable Model Context Protocol server exposing typed,
safety-classified Quad Cortex tools and resources. It uses the official MCP
Python SDK 2.x and does not depend on a desktop or mobile UI.

## Run from this repository

Install the two Python packages and the official SDK:

```powershell
python -m pip install -e packages/python/qc-gateway-client
python -m pip install -e services/mcp-server
python services/mcp-server/main.py --mode gateway --transport stdio
```

Install `qc-gateway-client` first because it is a local source dependency that
is not fetched from a public package index.

The repository entry point locates and owns the existing device-gateway
sidecar. For a packaged external gateway, pass its complete launch command with
`--gateway-command` or `NDSP_QC_GATEWAY_COMMAND`.

`--transport streamable-http --host 127.0.0.1 --port 8000` is also available.
It remains loopback-only by default. Do not expose the server to a LAN without
adding authentication and the MCP SDK's host/origin transport security.

## Ownership modes

- `gateway` (default): communicates through `qc-gateway-client` and the
  versioned framed JSON-RPC gateway contract.
- `direct`: composes the installed device-gateway adapter in-process and owns
  USB itself. The Windows app/Cortex Control must be closed. This mode requires
  the device gateway and hardware dependencies to be installed/importable.

In normal gateway mode only the native broker owns the QC USB session, and the
MCP server does not acquire HID or depend on a UI. Legacy `direct` mode is the
explicit development exception: its in-process Python adapter owns USB itself.

## Resources

- `qc://status`
- `qc://current-preset`
- `qc://models`

## Tools and safety

The complete 102-action tool surface is generated from
`contracts/qc-actions.v1.json`. It includes device and library reads; guarded
performance, Grid, routing, scene, parameter, I/O, global-setting, and library
writes; and persistent preset/backup operations. Master-volume changes and
preset reload are risky controls with explicit confirmation.

All preset-affecting mutations require expected preset/scene/value/position
state from a fresh snapshot. The gateway performs authoritative readback.
`save_preset_as` and `rename_current_preset` are deliberately separate and
additionally require `confirm_persistent_write=true`. Rename applies only to the
active stored user preset and verifies the new name. No arbitrary JSON-RPC,
protobuf, or raw HID tool is exposed; global settings use only their dedicated
typed, confirmation-gated actions.

The MCP server provides tools to an MCP host; it does not itself contain an LLM
or chat UI.

## Test and package

```powershell
python -m unittest discover -s services/mcp-server/tests -v
python -m pip install build
python -m build packages/python/qc-gateway-client
python -m build services/mcp-server
```

To validate the wheels in a clean environment, install the generated gateway
client wheel first, then the MCP server wheel, and run `ndsp-qc-mcp --help`.
