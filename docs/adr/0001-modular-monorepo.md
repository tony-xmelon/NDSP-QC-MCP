# ADR 0001: Modular monorepo with ports and adapters

- Status: Accepted
- Date: 2026-08-30

## Context

The project starts with a Windows desktop controller but must later support Android, iOS, web, MCP, and headless deployments. Quad Cortex control currently depends on an unofficial Python library, while clients may use several languages and UI frameworks. USB-HID access must have a single owner.

## Decision

Use a monorepo with a framework-independent Python core, a separate `pyquadcortex` adapter, versioned language-neutral contracts, thin client apps, a device gateway, and an independently packaged MCP server. All hardware mutations pass through the same typed use cases and safety policy.

The MCP server supports mutually exclusive direct-device and gateway-backed composition. It is not embedded in the Windows UI and does not define the device API.

## Consequences

- New clients can reuse contracts and behavior without importing desktop code.
- The unofficial protocol dependency is isolated and replaceable.
- Cross-language schemas and compatibility testing become required work.
- A gateway is necessary for phones that cannot or should not own USB directly.
- Some packaging and release configuration is duplicated intentionally so the MCP server remains independently distributable.
