# Pod acceptance tests

One folder per pillar. Each folder's README says what that pillar protects, why each file is there,
and what deliberately is not.

| Pillar                                        | Protects                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`sync-engine/`](sync-engine/README.md)       | A local answer is the answer the server would give; a write is visible before it settles.           |
| [`access-control/`](access-control/README.md) | Approval locks, terminal decisions, and the state every client is left holding.                     |
| [`mutations/`](mutations/README.md)           | One authoritative write path, atomic with version/history/audit/feed, refusals a person can act on. |
| [`hooks/`](hooks/README.md)                   | Authored hook code gets exactly the capabilities its phase can safely offer.                        |
| [`automations/`](automations/README.md)       | A declared automation runs, runs once per committed change, and records every run.                  |
| [`notifications/`](notifications/README.md)   | A message the workspace believes it sent reached a host, correctly scoped.                          |
| [`pipelines/`](pipelines/README.md)           | Export/import is authorized, policy-scoped, and serialized as declared.                             |
| [`authoring/`](authoring/README.md)           | Generated schema and builds are what the author meant, and destroy nothing.                         |

`support/` is shared harness code, not a pillar: a throwaway PostgreSQL container, a Node PGlite
replica, a compiled-runtime boot, and collection probes.

## Rules

**Infrastructure is mandatory.** Docker-backed suites call `requireDocker()`. A missing container
fails collection. A release run must never be green because it was made of skips, and the
million-row fixture fails rather than shrinking itself.

**Every resource is disposable and isolated.** Each PostgreSQL container is created per suite with a
random name and removed on teardown, including when setup throws. Nothing touches a developer's
local database, a shared instance, or a deployed environment: the harness only ever knows a
connection string it created.

**A test earns its place by failing for a reason nothing else covers.** Do not add tests that
restate TypeScript types, snapshot generated SQL without executing it, probe an optional feature and
accept either outcome, or mock a boundary another test already exercises for real.

**A gap is written down, not skipped.** Where a capability is incomplete — Core not draining
collection-event automations, `notifications` not being a declarable facility — the pillar README
says so. A skipped test reads as coverage; a paragraph does not.

## Running

```bash
pnpm --filter @norbital-ai/pod test
```

Suites run serially (`fileParallelism: false`): several boot a real runtime and build a template, and
concurrent builds write the same generated packages.

To run one pillar:

```bash
pnpm --filter @norbital-ai/pod exec vitest run tests/sync-engine
```
