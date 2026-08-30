# Contracts

Versioned, language-neutral wire schemas live here. They are the source of truth for gateway requests, responses, events, snapshots, errors, capabilities, and confirmation flows.

Initial implementation will use JSON Schema with generated Python and TypeScript models. Kotlin and Swift generation can be added when mobile stacks are selected. Generated files belong in ignored `generated/` directories and must not be edited manually.

Contracts expose semantic device operations; raw protobuf messages and `pyquadcortex` types are forbidden.

`gateway.v1.schema.json` is the first private stdio contract. Each UTF-8 JSON-RPC
message is prefixed with a four-byte unsigned big-endian payload length. Frames
are capped at 16 MiB and responses must carry the matching integer request ID.
