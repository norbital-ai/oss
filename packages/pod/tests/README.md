# Pod test architecture

The OSS package owns Pod conformance. These tests do not depend on Core and deliberately exercise
the same compiled runtime artifact in both hosted-style and standalone-style harnesses.

| Area                                      | Suite                                          | Boundary proved                                                               |
| ----------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| Compiler, generated types, authored roles | `compiler/`, `authoring/`                      | discovery, diagnostics, `$types`, manifests, policies and DDL                 |
| Sync engine                               | `sync-engine/`                                 | shape, filtered SSE, optimistic mutation, reset, reconnect, policy visibility |
| Mutations, hooks, access and approval     | `mutations/`, `hooks/`, `access-control/`      | every record write passes collection operations and tenant policy             |
| Automations, pipelines and notifications  | `automations/`, `pipelines/`, `notifications/` | durable dispatch and host-facility delivery                                   |
| File storage                              | `storage/`                                     | host byte binding plus Pod-owned asset rows and authorization                 |
| Agents, AI and transcript delivery        | `agents/`                                      | one-turn AI binding, Pod tool loop and synced tenant-owned messages           |
| Runtime and host contracts                | `runtime/`                                     | facilities, jobs, identity, inbound delivery and cross-pillar transactions    |
| Standalone boot/refusal                   | `standalone/`                                  | facility gate and process-level startup contract                              |

Database suites use stock PostgreSQL 18 and disposable
containers from it. This exercises the production temporal trigger rather than a test substitute.
The shared runtime harness serializes template compilation so parallel Vitest workers cannot
replace one another's build artifact. Docker is required: the full gate fails instead of silently
skipping a real-Postgres pillar.

Tests live with the pillar whose behavior they assert. A small number of compiled-runtime tests
cross pillars on purpose when the contract itself spans them—for example mutation → outbox →
automation → derived write—and those files name every boundary they cover instead of duplicating
the same scenario in each directory.
