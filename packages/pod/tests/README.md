# Pod test architecture

The OSS package owns Pod conformance. These tests do not depend on Core and deliberately exercise
the same compiled runtime artifact in both hosted-style and standalone-style harnesses.

| Area                                      | Suite                                     | Boundary proved                                                               |
| ----------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------- |
| Compiler, generated types, authored roles | `compiler/`, `authoring/`                 | discovery, diagnostics, `$types`, manifests, policies and DDL                 |
| Sync engine                               | `sync-engine/`                            | shape, filtered SSE, optimistic mutation, reset, reconnect, policy visibility |
| Mutations, hooks, access and approval     | `mutations/`, `hooks/`, `access-control/` | every record write passes collection operations and tenant policy             |
| Automations, pipelines and notifications  | `automations/`, `pipelines/`, `notifications/` | durable dispatch and host-facility delivery                               |
| File storage                              | `storage/`                                | host byte binding plus Pod-owned asset rows and authorization                 |
| Agents, AI and transcript delivery        | `runtime/`                                | one-turn AI binding, Pod tool loop and synced tenant-owned messages           |
| Standalone boot/refusal                   | `standalone/`                             | facility gate and process-level startup contract                              |

Database suites build a pinned PostgreSQL 18 image with `temporal_tables` 1.2.2 and use disposable
containers from it. This exercises the production temporal trigger rather than a test substitute.
The shared runtime harness serializes template compilation so parallel Vitest workers cannot
replace one another's build artifact.
