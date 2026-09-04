# Cross-module tests

This directory hosts contract compatibility, gateway/MCP integration, fault-injection, packaging, and opt-in real-hardware tests. Unit tests remain beside their owning modules.

`hardware-conformance.test.ts` keeps the physical case registry in exact lockstep
with the MCP action contract and tests its safety gates. The actual device run is
opt-in and documented in [`docs/HARDWARE_CONFORMANCE.md`](../docs/HARDWARE_CONFORMANCE.md).

Run `npm run test:parity:software` for the complete device-free integration
gate: both app type systems and test suites, generated contracts, gateway
coverage, and every shared/native Rust crate used by the product. Invoke
`scripts/verify-software-parity.ps1` directly with `-BuildApps` or
`-BuildAndroid` when build artifacts are also required. Physical releases still
require the separate Windows and Android hardware-conformance evidence.
