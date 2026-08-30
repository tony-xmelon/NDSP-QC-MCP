# Contracts

Versioned, language-neutral wire schemas live here. They are the source of truth for gateway requests, responses, events, snapshots, errors, capabilities, and confirmation flows.

Initial implementation will use JSON Schema with generated Python and TypeScript models. Kotlin and Swift generation can be added when mobile stacks are selected. Generated files belong in ignored `generated/` directories and must not be edited manually.

Contracts expose semantic device operations; raw protobuf messages and `pyquadcortex` types are forbidden.
