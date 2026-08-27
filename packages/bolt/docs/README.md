# Bolt internals

`@norbital-ai/bolt` is the portable tenant framework: authoring language, compiler, guest runtime,
and browser client. It is not a hosted control plane.

A claim here is trustworthy only when it can be found in `packages/bolt/src`.

Colony owns routing, CAS, isolates, and workbenches:
[`norbital/apps/colony/docs`](../../../../norbital/apps/colony/docs/README.md).

---

## Pillars

Bolt owns P4 and P5. Access and agents sit beside the pillars — they are guest-runtime contracts,
not host topology.

```text
packages/bolt/docs/
├── README.md                          ← you are here
├── pillars/
│   ├── 04-sync-engine/                P4  outbox, partitions, pull
│   └── 05-client/                     P5  PGlite replica, overlay, shell
├── access/                            identities, policies, approvals
└── agents/                            turns, tools, envoys
```

| Folder                                                       | Pins                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------- |
| [pillars/04-sync-engine](./pillars/04-sync-engine/README.md) | Outbox, poke, pull, partition, query / mutate path            |
| [pillars/05-client](./pillars/05-client/README.md)           | PGlite replica, windows, journal, leader, budget              |
| [access](./access/README.md)                                 | Subjects, teams, policies; [approvals](./access/approvals.md) |
| [agents](./agents/README.md)                                 | Tool loop, envoys vs automations                              |

| Colony               | Folder                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **P1 Tenant matrix** | [`apps/colony/docs/pillars/01-tenant-matrix`](../../../../norbital/apps/colony/docs/pillars/01-tenant-matrix/README.md) |
| **P2 Content store** | [`apps/colony/docs/pillars/02-content-store`](../../../../norbital/apps/colony/docs/pillars/02-content-store/README.md) |
| **P3 Runtime**       | [`apps/colony/docs/pillars/03-runtime`](../../../../norbital/apps/colony/docs/pillars/03-runtime/README.md)             |
| **P6 Workbench**     | [`apps/colony/docs/pillars/06-workbench`](../../../../norbital/apps/colony/docs/pillars/06-workbench/README.md)         |

---

## What Bolt is

```text
  src/  (tenant workspace)
    │
    │  bolt sync     validate + generate + client build + server artifact
    │  bolt migrate  append SQL lineage when models diverge
    │  bolt audit    optional @norbital-ai/doctor
    ▼
  .norbital/
    generated/   types, registry (compiler-owned)
    dist/        browser client (workspace.js)
    migrations/  authored SQL lineage (committed)
    artifact/
      bundle.mjs + code/*.mjs + release.json + assets/<sha256>
    │
    │  host loads bundle.mjs into an isolate (Colony) or Node (bolt-server)
    ▼
  guest runtime  dispatch → collections / sync / agents / automations / identity
    │
    │  facilities (host-provided): database, files, ai, tasks, transport, …
    ▼
  browser client  PGlite replica, live queries, overlay writes, agent UI
```

Colony publishes the artifact into P2 and routes `(tenant, environment) → release` (P1). Bolt never
sees another tenant.

---

## Authoring layout

Discovery is `src/compiler/sync.ts`. The kind is the directory, the name is the file, and a
leading `+` means the compiler reads it.

```text
src/
├── +agents.md                     # required — workspace prompt (web + envoy)
├── +env.ts                        # optional — defineEnvironment
├── access/
│   ├── +teams.ts
│   ├── +anonymous_limits.ts
│   └── policies/+<name>.ts
├── capabilities/
│   ├── tools/+<name>.ts
│   ├── mcp/+<name>.ts
│   └── skills/<name>/+skill.md
├── collections/
│   ├── +relationship.ts           # optional (empty relations if absent)
│   └── <name>/
│       ├── +model.ts              # required (at least one collection)
│       ├── +hooks.ts
│       ├── +pipelines.ts
│       ├── +integrations.ts
│       └── +representation.svelte
├── datatypes/<name>/
│   ├── +definition.ts
│   └── +renderer.svelte
├── apps/
│   ├── +<app>.svelte
│   └── <group>/+group.ts, +<app>.svelte
├── automations/+<name>.ts
├── envoys/+<name>.ts
├── functions/+<name>.ts
├── i18n/messages.{en,zh}.json
└── lib/**                         # no compiler role
```

A leading `+` means the compiler reads the file. A stray `+` file is a build error
(`discoverAuthoredSource` in `src/compiler/sync.ts`). `collections/+relationship.ts` is a
known optional file, not a stray.

There is no `bolt build`, no `+agent.ts`, no `+seed.ts`. Fixtures come from `seed_bank/` via
Colony. Generated `.norbital/{diagnosis,dist,generated,types}` is never hand-edited;
`.norbital/migrations/` is committed lineage.

The workspace **handle** is `norbital.template.json`'s `key` (`norbital_hr`, `norbital_bca`).
It is the tenant id and the string typed at `/login`. It is not the directory name
(`templates/hr-payroll/`).

---

## Guest runtime

`src/runtime/app.ts` builds Effect layers from the artifact. `src/runtime/dispatch.ts` routes
commands (`collections.mutate`, `sync.pull`, `agents.enqueue`, …).

The guest has no Node builtins. Every I/O port is a facility the host binds per invocation
(`packages/bolt-protocol/src/facilities.ts`). On Colony that binding happens inside a fresh
isolated-vm context; see [P3 Runtime](../../../../norbital/apps/colony/docs/pillars/03-runtime/README.md).

Reads and writes on `api.db.<collection>` are policy-guarded. Browser mutations go through
`collections.mutate`. Vector search (`findNearest`) is a server verb; the browser client does not
declare it.
