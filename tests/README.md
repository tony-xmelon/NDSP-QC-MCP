# Cross-module tests

This directory hosts contract compatibility, gateway/MCP integration, fault-injection, packaging, and opt-in real-hardware tests. Unit tests remain beside their owning modules.

`hardware-conformance.test.ts` keeps the physical case registry in exact lockstep
with the MCP action contract and tests its safety gates. The actual device run is
opt-in and documented in [`docs/HARDWARE_CONFORMANCE.md`](../docs/HARDWARE_CONFORMANCE.md).
