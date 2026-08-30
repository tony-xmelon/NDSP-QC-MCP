# Standalone MCP server

An independently installable Model Context Protocol server exposing typed, safety-classified Quad Cortex tools and resources.

Planned modes:

- `direct`: compose `qc-core` and `qc-pyquadcortex` and own USB directly;
- `gateway`: connect through `qc-gateway-client` when another process owns USB.

This service has its own package metadata, CLI entry point, tests, and release artifact. It must not depend on any client app or UI package.
