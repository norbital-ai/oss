# Pod test architecture

The OSS package owns Pod conformance. These tests do not depend on Core and deliberately exercise
the same compiled runtime artifact in both hosted-style and standalone-style harnesses.

| Area                                       | Suite                            | Boundary proved                                                               |
| ------------------------------------------ | -------------------------------- | ----------------------------------------------------------------------------- |
| Filesystem compiler and generated types    | `compiler/`                      | discovery, diagnostics, `$types`, authoring unions                            |
| Sync engine                                | `sync/`                          | shape, filtered SSE, optimistic mutation, reset, reconnect, policy visibility |
| Mutation, access control, approval, audit  | `collection/`, `sync/*approval*` | every record write passes collection operations                               |
| File storage                               | `storage/`                       | host byte binding plus Pod-owned asset rows and authorization                 |
| Agents, AI, automation transcript delivery | `runtime/`                       | one AI binding, Pod tool loop, synced step-level transcript                   |
| Standalone boot/refusal                    | `standalone/`                    | facility gate and process-level startup contract                              |

Database suites build a pinned PostgreSQL 18 image with `temporal_tables` 1.2.2 and use disposable
containers from it. This exercises the production temporal trigger rather than a test substitute.
The shared runtime harness serializes template compilation so parallel Vitest workers cannot
replace one another's build artifact.
