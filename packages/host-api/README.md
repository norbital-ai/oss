# `@norbital-ai/host-api`

The versioned contract between a host and a Bolt release. A host (Colony, `bolt-server`, or a third-party host) depends on this package rather than Bolt's engine; a release's Bolt depends on it and answers it.

Entries:

- `@norbital-ai/host-api` — `HOST_API_VERSION`, `HostApi`, facility/port types, boundary Schemas, Studio port, errors, SQL wire helpers and the conformance kit (cell-safe)
- `@norbital-ai/host-api/node` — shared Node port implementations (including the `node:vm` guest runner) and signed host operations
- `@norbital-ai/host-api/node/guest-hooks` — Node module-loader hooks for confined guest execution
