# qc-gateway-client

Python client for the versioned `gateway.v1` JSON-RPC contract. It provides:

- `StdioGatewayClient`, which owns a gateway child process and communicates using
  the existing length-prefixed private transport;
- `InProcessGatewayClient`, used by direct-ownership composition and tests.

It exposes only structured `system.*` and `device.*` calls. It has no HID,
protobuf, UI, or MCP dependency.
