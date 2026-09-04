# QC remote service

Production composition root for the public QC Control connector. It mounts the
Rust `rmcp` Streamable HTTP server at `/mcp` and the authenticated Android relay
routes from `qc-relay` in one Axum application.

The service is an OAuth 2.1 resource server, not an identity provider. Configure
an authorization server that supports authorization-code + S256 PKCE and token
introspection, plus client registration suitable for ChatGPT and Claude (dynamic
registration, client-ID metadata documents, or provider-specific preregistration).
The relay validates the authorization-server metadata at startup
and validates token activity, exact issuer, exact audience/resource, expiry, and
scope for every request.

Required environment variables:

```text
QC_RELAY_PUBLIC_URL=https://qc.example.com
QC_RELAY_ISSUER_URL=https://auth.example.com
QC_RELAY_INTROSPECTION_URL=https://auth.example.com/oauth2/introspect
QC_RELAY_OAUTH_CLIENT_ID=qc-relay-resource-server
QC_RELAY_OAUTH_CLIENT_SECRET=<load from the deployment secret store>
```

`QC_RELAY_BIND` defaults to `127.0.0.1:8080`. Put a TLS reverse proxy in front
of it and overwrite the inbound `X-Forwarded-Proto` header; requests are refused
unless the trusted proxy reports `https`. Do not bind the process directly to a
public interface without an equivalent trusted TLS boundary.

Run and verify:

```powershell
cargo run --manifest-path services/qc-remote/Cargo.toml
cargo test --manifest-path services/qc-remote/Cargo.toml
```

Connector clients use `https://qc.example.com/mcp`. The same URL and OAuth flow
works for a ChatGPT plugin/connector and a Claude custom remote MCP connector.
Provider consumer tokens, browser cookies, and provider API secrets never enter
QC Control or this service.

This first production vertical slice is intentionally single-instance: device
credentials and pairing offers are held in memory, so a service restart requires
phones to pair again. Replace those stores with a shared durable implementation
before horizontal scaling; the authorization and device-routing boundaries stay
the same.

Pairing flow:

1. The signed-in user requests `POST /v1/pairing/offers` with `qc:pair` scope.
2. The user pastes or scans the returned short-lived, one-use secret in QC Control.
3. Android redeems it at `POST /v1/device/pair` and stores the returned device
   credential with Android Keystore-backed encryption.
4. The foreground service opens `wss://qc.example.com/v1/device/connect`, using
   `Authorization: Bearer` and the `qc-relay.v1` subprotocol.
5. MCP calls are routed only to the authenticated principal's sole USB-ready
   phone. More than one active phone fails closed as ambiguous.

Persistent and risky actions pass two gates: the Rust MCP surface validates and
consumes the explicit confirmation flag, and public relay invocation independently
requires confirmation provenance plus the action-specific flag. The trusted
in-process MCP adapter still rechecks the RPC allowlist and device ownership.
Android additionally applies its device-local access setting on every relay request.
It defaults to full control; read-only mode permits status and device inspection but
rejects mutations before they enter the USB command path.
