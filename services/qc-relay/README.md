# QC Relay

`qc-relay` is the authenticated routing core between a remote MCP resource server
and the QC Control Android foreground service. It contains no raw USB, HID,
protobuf, arbitrary-RPC, browser-cookie, consumer-login-token, or provider-secret
surface.

## Integration

- Construct `PublicEndpointConfig` with the exact public HTTPS resource URI and
  authorization-server issuer identifiers. Prefer
  `from_authorization_server_metadata`; it rejects authorization servers that do
  not advertise S256 PKCE.
- Supply a `BearerTokenValidator` implementation that performs signature and
  OAuth token validation. The HTTP boundary additionally checks exact issuer and
  resource/audience, expiry, and required scopes on every request.
- Serve `router(state)` with Axum's `into_make_service_with_connect_info` so
  pairing redemption receives the peer address used for brute-force limits.
- Terminate TLS directly, or bind the app only to a private interface behind the
  explicitly trusted reverse proxy selected by `TlsTermination::TrustedProxy`.
- MCP handlers should call `RelayHub::invoke_for_principal`. It chooses the sole
  authenticated, paired, USB-ready phone and rejects zero or ambiguous sessions.

The Android protocol uses `POST /v1/device/pair` followed by an outbound
WebSocket to `/v1/device/connect` with a bearer device credential and the
`qc-relay.v1` subprotocol. Pairing secrets and credentials are retained only as
SHA-256 digests. Pairing secrets are one-time, expiring, replay-protected, and
rate-limited. Persistent storage can replace the in-memory stores behind the
same service boundary before horizontally scaling the relay.

OAuth protected-resource metadata is published at
`/.well-known/oauth-protected-resource`. Control and pairing-management routes
return a `WWW-Authenticate` challenge containing that metadata URL and the
required scope when bearer authorization fails.

Run checks with:

```powershell
cargo test --manifest-path services/qc-relay/Cargo.toml
cargo clippy --manifest-path services/qc-relay/Cargo.toml --all-targets -- -D warnings
```
