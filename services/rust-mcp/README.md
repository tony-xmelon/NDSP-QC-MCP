# QC Remote MCP (Rust)

Production MCP protocol surface for QC Control. It publishes only the typed,
intent-level actions in `contracts/qc-actions.v1.json` through rmcp Streamable
HTTP and delegates execution to a principal-scoped `QcBackend`.

This crate deliberately has no standalone public listener. Mount `mcp_router`
behind the relay's OAuth authorization, HTTPS termination, origin/host checks,
and rate limits. Construct each `QcMcp` with a backend scoped to exactly one
authenticated user and paired device; never use a process-global device route.
The authorization middleware must insert a `PrincipalRoute` into each request's
Axum extensions. Calls without it fail closed before the backend is reached.

The backend contract receives an allowlisted gateway RPC and validated camelCase
parameters. Confirmation-only flags are consumed at the MCP boundary and are not
trusted or forwarded as device commands.

Run `cargo test --manifest-path services/rust-mcp/Cargo.toml`.
