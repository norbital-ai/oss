# Pod architecture and delivery plan

Pod is a complete, self-contained tenant workspace runtime. Core is a host that supplies the
facilities Pod asks for, and makes hosting and authoring dramatically easier.

That distinction is the test every decision in this document is measured against: **Core must make
things simpler, never possible.** A capability that only works on Core is a capability Pod failed to
own.

Sections 1–5 describe the target design. Sections 6–9 describe what exists today, where to find it,
and how to get from one to the other — read those first if you are picking this up cold.

---

## 1. Architecture

### The boundary

```
┌─ TENANT WORKSPACE (Pod) ─────────────────────────────────────────┐
│                                                                  │
│  authoring    collections · hooks · apps · remotes · automations │
│  data         collection_ops · policy scope · approvals · audit  │
│  sync         local replica · change feed · live queries         │
│  agent        loop · tool execution · model selection · transcript│
│  notify       the `system` channel                               │
│                                                                  │
│  no network. no credentials. no host knowledge.                  │
└───────────────────────────┬──────────────────────────────────────┘
                            │  facility bindings
                            │  (stdio frames when hosted, in-process when standalone)
┌───────────────────────────┴──────────────────────────────────────┐
│  HOST                                                            │
│                                                                  │
│  db · fileStorage · maps · notifications · ai · queue            │
│  integrationDelivery                                             │
│                                                                  │
│  holds every credential. owns every socket.                      │
└──────────────────────────────────────────────────────────────────┘
```

### The rule that decides where anything goes

> **Anything that reads or writes tenant records runs in Pod.
> Anything that touches the outside world runs in the host.**

Every subsystem below is an application of that sentence. When a new capability appears, sort it
with the rule rather than inventing a policy for it.

Pod must own the tenant-record half because only Pod has the workspace registry, the requestor's
policy scope, the hooks, `_ops_guard`, the approval gate, temporal versioning and the audit trail.
A host writing tenant rows directly bypasses all of it.

The host must own the outside-world half because the tenant runtime container runs with
`--network=none` and a read-only root; stdio is its only channel.

### What "agnostic" means here

Pod is **host-agnostic**: it declares what it needs and consumes bindings, and the same bundle runs
on Core, on a self-hosted deployment, and under `pod dev` with no source change.

Pod is **not database-agnostic**, deliberately. The sync engine's exactly-once ordering depends on
`pg_current_xact_id` and `pg_snapshot_xmin`; workspace exclusions depend on `btree_gist`; the
standalone binding requires PostgreSQL 18 or newer. `HostDbBinding` is a seam for *where* Postgres
lives — local, Neon, RDS — not for *which* database it is. Writing an adapter for another engine
would not work, and the contract should not be read as inviting one.

**`pod.host.ts` is never loaded in hosted mode.** Not overridden — never read. `loadHostConfig` runs
only in the standalone entry point; the hosted runtime receives bindings over stdio and never
touches a config file. That is what makes moving a workspace between the two seamless: the source
tree is identical, and `pod.host.ts` is development scaffolding in the same category as `.env`.

```
STANDALONE                      HOSTED (Core)
pod.host.ts ──▶ bindings        Core ──▶ bindings over stdio
                                pod.host.ts not read
```

Nothing about a workspace's *source* is host-specific, and it cannot be: a workspace names only what
its own compiler can see. What varies between hosts is which facilities are available, and the gate
reconciles that at startup.

### The two host modes

Identical bundle, identical facility gate. Only who supplies the bindings and who owns the socket
differs.

```
HOSTED (Core)                          STANDALONE (pod start / pod dev)
─────────────                          ────────────────────────────────
container, --network=none              in-process HTTP on loopback
stdio frames                           direct function calls
Core serves dist/ itself               standalone serves dist/
Core supplies all facilities           pod.host.ts supplies them
trusted-header identity                pluggable identity provider
```

### Request lifecycle

```
browser ─▶ /_pod/bootstrap or /_runtime/*
              │
              ▼
     identity provider           establishes requestor + organisation
              │
              ▼
        buildCtx()               resolves the full policy scope from the tenant DB
              │
              ▼
   runWithWorkspaceContext()     scope-bound execution
              │
    ┌─────────┴─────────┬──────────────┬─────────────┐
    ▼                   ▼              ▼             ▼
 sync/*            runtime/run     files/*      remotes/*
 shape·stream      hooks           upload       typed handlers
 mutate·schema     automations     delete
                   pipelines
                   outbox
```

### Source layout

```
packages/pod/src/lib/
├── authoring/            what a workspace author writes against
│   ├── automations/      defineAutomation (handler | spec union)
│   ├── schema/           collection + field definitions
│   └── workspace/        hook API — api.db, api.ai, api.sendNotification
├── host/                 the host contract and its built-in adapters
│   ├── types.ts          PodHostConfig, definePodHost, satisfiedFacilities, env
│   ├── db.ts             postgresDb
│   ├── identity.ts       devIdentity, trustedHeaderIdentity
│   ├── file-storage.ts   localFileStorage
│   ├── s3.ts             s3FileStorage (SigV4, no SDK dependency)
│   ├── facilities.ts     consoleNotifications, stubMaps
│   ├── notifications.ts  notificationProviders                        [planned]
│   └── cron.ts           5-field cron matcher
├── server/
│   ├── agent/            loop · tool registry · transcript            [planned]
│   ├── collection/       collection_ops, access control, sync engine
│   ├── notifications/    system channel + outbox                      [planned]
│   ├── integrations/     tenant outbox
│   ├── run/              automations, pipelines, facility accessor
│   └── bootstrap/        context, scope resolution, runtime routing
├── runtime/              serve.ts (stdio guest loop), server.ts (handlePodRequest)
├── client/               generated client, sync, local query executor
├── bin/invocation/       CLI: sync · check · build · migrate · seed · start · dev
│   ├── standalone.ts     the standalone HTTP host
│   ├── host-config.ts    pod.host.ts loader + built-in defaults
│   └── scheduler.ts      cron automations + outbox drains
└── vite/                 filesystem compiler and plugin
```

---

## 2. How a host supplies facilities

### One config file, adapters as values

```ts
// pod.host.ts — the only file a self-hoster writes
import {
  definePodHost, env,
  postgresDb, s3FileStorage, notificationProviders, devIdentity
} from '@norbital-ai/pod/host';

export default definePodHost({
  db: postgresDb({ url: env('DATABASE_URL') }),
  identity: devIdentity({ /* … */ }),
  fileStorage: s3FileStorage({
    bucket: env('S3_BUCKET'),
    region: env('S3_REGION'),
    endpoint: env('S3_ENDPOINT'),
    accessKeyId: env('S3_ACCESS_KEY_ID'),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    forcePathStyle: true
  }),
  notifications: notificationProviders(smtpEmail({ url: env('SMTP_URL') })),
  scheduler: { automations: true }
});
```

Adapters are values, so a configuration stays data — readable, diffable, checkable — rather than
setup code. A workspace with no `pod.host.ts` gets built-in defaults: Postgres from `DATABASE_URL`,
local file storage, console notifications, a maps placeholder, and the scheduler on.

### The gate

```
        built workspace                        host configuration
              │                                        │
              ▼                                        ▼
  requiredRuntimeFacilities(manifest)        satisfiedFacilities(config)
    file field      → fileStorage              db            ← db adapter
    geolocation     → maps                     fileStorage   ← storage adapter
    automations     → queue                    maps          ← maps adapter
    agent spec      → ai                       ai            ← model provider
    integrations    → integrationDelivery      queue         ← scheduler.automations
    extra channels  → notifications            notifications ← providers
              │                                        │
              └────────────────┬───────────────────────┘
                               ▼
                  assertStandaloneFacilities()
                               │
                 ┌─────────────┴─────────────┐
              covered                    not covered
                 │                            │
                 ▼                            ▼
              serve            refuse to start, naming the facility
```

A workspace cannot know its host at author time, so the gate is the only place the answer is
knowable. It fires at startup, so an author learns at deploy rather than at 6am when the cron fires.

| Facility | Required when | Built-in adapter |
| --- | --- | --- |
| `db` | always | `postgresDb` |
| `fileStorage` | workspace has a file field | `localFileStorage`, `s3FileStorage` |
| `maps` | workspace has a geolocation field | `stubMaps` (degrades) |
| `notifications` | workspace declares a non-`system` channel | `notificationProviders(...)` |
| `ai` | agent automation, or any `api.ai` use | host-supplied |
| `queue` | automations exist | in-process scheduler |
| `integrationDelivery` | workspace declares integrations | host-supplied |

---

## 3. Notifications

`system` is Pod's channel, not a provider. Providers extend the reachable set; each adds one
channel, and every one of them is a credential plus an outbound socket, so all of them are the
host's.

```
api.sendNotification({ channels: ['system','email'], recipient_user_id, subject, message })
   │
   ├─ system ─▶ notification row ─▶ sync ─▶ in-app bell
   │            (caller's transaction; the host never sees this channel)
   │
   └─ email ──▶ notification_outbox row
                (caller's transaction)
                       │ COMMIT
                       ▼
               host drain loop  ─▶ {kind:'notification', action:'claim'}
                       ▼
               notifications.send({ channel:'email', recipientUserId, … })
                       ▼
               provider API ─▶ {action:'delivered'} | {action:'failed', retryAt}
```

Two commit rules, because the halves have different failure models:

- **`system` writes in-transaction.** If the hook rolls back, the notification never existed.
- **External channels queue in-transaction and deliver post-commit.** You cannot un-send an email,
  so it must not fire until the write it describes is durable.

`notification_outbox` is shaped exactly like `integration_outbox` — claim, deliver, settle, retry
with backoff — and drains through the scheduler loop that already exists.

### Type safety, in two layers

**Compile time, inside the workspace.** The channel union is generated. Omit the declaration and you
get `system` only.

```ts
// src/+notifications.ts — optional
export default defineNotifications({ channels: ['email', 'telegram'] });
```

`pod sync` generates `type NotificationChannel = 'system' | 'email' | 'telegram'` into `$types`, so
`channels: ['sms']` is a compile error rather than a runtime `{ sent: false }` found in production.

**Startup, at the host boundary.** Declared channels reach the manifest, `requiredRuntimeFacilities`
emits `notifications`, and the gate checks the host's provider set covers the declaration.

### Host contract

```ts
export type NotificationProvider = {
  readonly channel: string;
  send(input: NotificationDelivery): Promise<{ sent: boolean; reason?: string }>;
};

export type HostNotificationsBinding = {
  readonly channels: readonly string[];   // the gate checks coverage against the manifest
  send(input: NotificationDelivery): Promise<NotificationDeliveryResult>;
};

export function notificationProviders(
  ...providers: readonly NotificationProvider[]
): HostNotificationsBinding;
```

A host declaring a `system` provider is rejected at startup. That channel is Pod's, and a host
silently shadowing it would break in-app delivery in a way nobody would find.

**Pod passes a `recipientUserId`, never an address.** The host resolves it to an email, chat id or
phone number and applies whatever per-user preferences and opt-outs it keeps — the host's data, not
the tenant's. *Pod says who and what; the host says how to reach them.*

On Core this is three changes and none of them touch the send code: wrap each existing sender as a
`NotificationProvider`, advertise the resulting `channels` array, and add one pg-boss worker beside
the cron scheduler to drain the outbox.

---

## 4. Agents

Pod owns the loop. That is what keeps Pod and Core independent — if the host owned it, Pod could not
run an agent without Core. The loop, tool execution, model selection, the transcript and resume are
identical on Core and on a self-hosted deployment.

### Two agents, not one

Conflating these is the easiest mistake to make. They differ in what they operate on, and everything
else follows.

|  | **Workspace agent** | **Template agent** |
| --- | --- | --- |
| Runs in | the tenant runtime (Pod) | the host (Core) |
| Operates on | tenant **records** | the workspace **source tree** |
| Job | business automation — triage, draft, summarise | authoring and modifying the template |
| Network | none, by construction | yes |
| Tools | Pod built-ins + tenant-defined | `web_fetch`, `code_execution`, `read_file`, `write_file` |
| Pod contract | the `ai` facility — inference only | none; it never enters the tenant runtime |

```
┌─ TENANT RUNTIME ─────────────────┐   ┌─ HOST ─────────────────────────────┐
│  workspace agent                 │   │  template agent                    │
│    describe_workspace            │   │    read_file · write_file          │
│    read_collection               │   │    code_execution · web_fetch      │
│    write_collection              │   │                                    │
│    +<name>.tool.ts               │   │  edits +model.ts, +hooks.ts, apps  │
│                                  │   │  then runs `pod check`             │
│  acts on rows                    │   │  acts on source                    │
└──────────────────────────────────┘   └────────────────────────────────────┘
        no network                          never touches tenant rows
```

The tool sets are **disjoint and never merged**. A workspace agent must never hold `write_file`: an
agent editing source would be editing the very definitions its own scope, hooks and approval gates
are derived from — it could rewrite its own constraints mid-run. A template agent has no
`read_collection`, because template authoring is not a data operation.

Consequently Pod carries **no host-tool plumbing at all** — no `hostTools`, no `executeHostTool`, no
`agentTools` on the host configuration. The provider supplies inference and nothing else.

### The workspace agent's tools

| Kind | Source | Declared by |
| --- | --- | --- |
| `describe_workspace` | Pod built-in, always on | implicit |
| `read_collection` / `write_collection` | Pod built-in | `access` + `collections` |
| Tenant-defined | `+<name>.tool.ts`, anywhere under `src/` | `tools`, compiler-validated |

Data access is a **mode, not a tool list**: `access: 'read' | 'write'` decides whether
`write_collection` is exposed, and the typed `collections` array bounds what either built-in may
touch. That reads as the permission grant it is, and keeps `tools` exclusively for tenant-defined
tools — one source, one generated union, no built-in names blended in.

Tenant tools are **discovered by suffix, not registered**: the compiler finds any `+<name>.tool.ts`
the same way it finds collections and remotes, so a tool can sit beside the collection it serves.

```ts
// src/collections/permits_to_work/+check_permit_registry.tool.ts
export default defineAgentTool({
  description: 'Look up a permit and its outstanding conditions.',
  input: z.object({ permit_no: z.string() }),
  async run(api, { permit_no }) {
    return api.db.query.permits_to_work.findFirst({ where: { permit_no } });
  }
});
```

The zod schema becomes the JSON Schema the model sees, so description and argument shape live in one
place. `run` receives the same `api` a hook gets, so a tenant tool executes under the automation's
scope and cannot escape policy — which is why it runs in Pod rather than the host.

`describe_workspace` is implicit because an agent that cannot see the tenant's schema is useless, and
describing the schema in the prompt guarantees drift. It reports the **whole** schema, not a
scope-filtered view: schema is not data, knowing a column exists reveals nothing about any row, and
every tool that reads records still enforces the requestor's scope. `collections` narrows what is
reported as relevance, not as a security boundary.

If a workspace agent needs information from outside, that is an **integration** — outbound delivery
driven by the host — not a host tool. The tenant runtime has no network and that boundary should not
be worked around by handing it one.

An agent's writes go through `collection_ops`, so **approval gates, hooks, versioning and audit apply
to everything an agent does** without the author opting in.

**Every tool call and every result is a step — no exceptions.** A tool that ran without leaving a
step is a hole in the transcript, and a transcript with holes cannot answer what the agent did.

### The transcript, and how it reaches the client

`agent_run_step` is a child of `automation_run`: `sequence`, `kind`
(`message` / `tool_call` / `tool_result` / `error`), `content`, `tool_name`, `tool_input`,
`tool_output`, `usage`, `created_at`.

It is an **ordinary collection, written insert-once**. Steps are never updated, and
`_norbital_versioning` archives only on UPDATE/DELETE, so they generate no history rows. Everything
reaches the client through the sync engine at **per-turn granularity** — there is no token stream, no
delta channel, and nothing for a host to route.

The granularity choice is the whole design, and the line is an order of magnitude wide:

```
                    writes/run     with 20 connected clients
  token-level        ~120–500      2,400–10,000 scoped reads
  step-level             12        240 scoped reads over a multi-minute run
```

`buildDiff` runs for every outbox row against every connected client — a policy-scoped `findFirst`
each, with no subscription filter — so the cost is genuinely rows × clients. At twelve writes per run
that is a few reads per second; at token granularity it is not.

Putting steps through the sync engine means refresh, reconnect, offline catch-up, multi-tab
convergence and local querying all come from machinery that already exists and is already tested.
A refresh needs no handling at all: the conversation is already in the local replica.

The cost is that a turn appears when it completes rather than typing out. Liveness comes from
`automation_run.status` and the newest step's timestamp, both synced.

**Liveness must not be a heartbeat column on `automation_run`.** It is a synced collection, so a
periodic heartbeat would be an UPDATE per interval carrying a history row, an outbox row, a notify
and a diff read per connected client. Liveness is derived from the steps instead — one is written
every turn, so the newest step *is* the heartbeat, and the scheduler sweep fails any running
automation whose latest step is older than the lease. The lease must therefore exceed the slowest
expected turn. A restart resumes from `max(sequence)`.

**Watch the propagation, but watch the right half of it.** An agent's own record writes dominate its
transcript by an order of magnitude:

```
one agent turn that updates 40 permits
        ├─ 40 × collection_ops writes  ──▶ 40 outbox rows ──▶ 40 notifies
        ├─  1 × agent_run_step insert  ──▶  1 outbox row
        └─  n × notification / approval rows, if the turn produced any
```

Tuning twelve step rows per run while a single turn can emit forty record diffs is optimising the
wrong end. Three consequences: the subscription filter on `buildDiff` is the load fix that matters,
and it pays off against record writes far more than against steps; bulk-triggered agents are the real
risk, since a change-triggered agent on a thousand-row import is a thousand runs each writing
records; and the burst path itself is already sound, because the tailer drains the outbox in batches
rather than waking once per notify.

### Declared and interactive runs

Two entry points share one loop, one tool set and one transcript. They differ only in what starts a
run and whether it accepts input while live.

| | **Declared** | **Interactive** |
| --- | --- | --- |
| Started by | a trigger on `defineAutomation` | a user, from the agent view |
| Bound to | a named automation | nothing — an ad-hoc run |
| Mid-run input | none | user turns continue the run |
| Record | `automation_run` | the same table, with no automation name |

```
POST /_runtime/agent/start   → { runId }   start a run, or append a user turn
```

That is the entire interactive surface. Everything else is a live query over synced records.

### Provider contract — one method

One-shot inference is a degenerate agent run: a single turn with no tools. So the provider exposes
**one** method, and Pod builds the authoring surface on top of it rather than the host implementing
the same thing twice.

```ts
export type HostAiBinding = {
  chat(input: {
    messages: readonly AiMessage[];
    tools?: readonly AiToolSpec[];
    outputSchema?: unknown;    // structured output
    model?: string;
    profile?: string;          // opaque host extension (Core's agent profiles ride here)
  }): Promise<{
    text: string;
    toolCalls?: readonly { id: string; name: string; input: unknown }[];
    stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal';
    usage?: unknown;
  }>;
};
```

A provider author writes exactly one function, so their one-shot and multi-turn paths cannot disagree
about model defaults, refusal handling, or usage accounting. There is nothing else in the contract:
host tools belong to the template agent, which never enters the tenant runtime.

**The authoring surface collapses to one call too.** `aiInfer` and `aiInferStructured` become a single
`api.ai(...)`: pass a zod schema and you get that type back, omit it and you get text.

```ts
const summary = await api.ai({ prompt });                        // string
const permit  = await api.ai({ prompt, schema: PermitSchema });  // z.infer<typeof PermitSchema>

ai<S extends z.ZodType | undefined = undefined>(input: {
  prompt: string; schema?: S; model?: string;
}): Promise<S extends z.ZodType ? z.infer<S> : string>;
```

An agent calls the same thing when it wants a structured result, so there is one inference path in
the workspace rather than a hook flavour and an agent flavour that can drift.

An OSS provider is roughly forty lines and gets a fully DB-capable workspace agent; Core wires its
own provider automatically and a tenant configures nothing.

### Authoring

The second argument of `defineAutomation` is a union: a handler function, or a spec object
discriminated on `kind`. There is no separate `defineAgent` — the discriminant does the typing.

```ts
// src/automation/+permit_expiry_watch.ts — deterministic
export default defineAutomation({ schedule: '0 6 * * *' }, async (api: Api) => {
  const permits = await api.db.query.permits_to_work.findMany({ limit: 250 });
  return { summary: { permit_count: permits.length } };
});

// src/automation/+permit_expiry_triage.ts — agent, minimal
export default defineAutomation(
  { schedule: '0 6 * * *' },
  { kind: 'agent', task: 'Summarise permits expiring within 14 days.' }
);

// the same, scoped and explicit
export default defineAutomation(
  { schedule: '0 6 * * *' },
  {
    kind: 'agent',
    task: 'Draft a renewal for each permit expiring within 14 days.',
    systemPrompt: 'You are a compliance officer. Never approve a renewal yourself.',
    collections: ['permits_to_work', 'permit_renewals'],  // typed: this workspace's collections
    access: 'write',                                       // 'read' (default) | 'write'
    tools: ['check_permit_registry'],                      // typed: this workspace's own tools
    maxIterations: 12
  }
);
```

Every field but `kind` and `task` is optional: `access` defaults to `'read'`, `maxIterations` to 8,
`collections` to everything the automation's scope reaches, and `tools` to none. Both typed arrays
are generated by the compiler from the real workspace, so a typo in either is a compile error.

> **Only `{ schedule }` triggers currently fire.** Collection-event triggers type-check and compile
> but nothing dispatches them — gap 1.

---

## 5. A workspace on disk

```
my-workspace/
├── pod.host.ts                       host facilities — self-hosting only
├── vite.config.ts                    pod() — the only framework configuration
├── .env                              DATABASE_URL, POD_* …
├── src/
│   ├── +notifications.ts             declares non-system channels          [planned]
│   ├── +seed.ts                      optional development seed
│   ├── collections/
│   │   ├── +relationship.ts
│   │   └── permits_to_work/
│   │       ├── +model.ts
│   │       ├── +hooks.ts
│   │       ├── +representation.svelte
│   │       └── +check_permit_registry.tool.ts    tenant agent tool       [planned]
│   ├── automation/
│   │   ├── +permit_expiry_watch.ts   deterministic
│   │   └── +permit_expiry_triage.ts  agent
│   ├── apps/
│   ├── remotes/
│   └── custom-types/
└── .norbital/
    ├── migrations/                   committed
    ├── generated/                    ignored — assembly + $types
    ├── types/                        ignored
    ├── storage/                      ignored — local file storage
    └── build/                        ignored — deployable output
```

---

## 6. What the current system lacks

Everything here was verified against source, not assumed. Numbers are referenced from the takeover
map and the delivery plan.

| # | Gap | Where | Consequence |
| --- | --- | --- | --- |
| 1 | Collection-event automations never fire | `server/run/automation-dispatch.server.ts` has no caller; Core `automation-scheduler.server.ts` registers only `cron_schedule`; `ManifestAutomationTemplate` has no trigger field | `defineAutomation({trigger:{collection,event}})` compiles and is inert |
| 2 | Agent automations are refused by the runtime | `server/run/tenant_run.ts` — `is not a deterministic automation` | The entire agent surface is unimplemented |
| 3 | `notification` table is never written | `server/collection/hook-api.server.ts` — `sendNotification` returns `crypto.randomUUID()` | No in-app notifications; the id points at no row; `read_at` unusable |
| 4 | `notifications` is never a declared facility | `platform-utils/runtime/binding.ts` | A workspace needing email deploys to a host that cannot send it |
| 5 | `aiInferStructured` / `aiInfer` are not declared either | same | Pass the gate, then 503 at runtime |
| 6 | Standalone installs no `DatabaseNotifications` | `bin/invocation/standalone.ts`; seam at `sync/db-notifications.server.ts` | `pod dev` sync wakes only on the heartbeat |
| 7 | Scheduler serialises automations ahead of outbox delivery | `bin/invocation/scheduler.ts` — `sweep()` | One slow automation stalls integration delivery for its duration |
| 8 | No overlap rule for automations | `bin/invocation/scheduler.ts` | An hourly automation taking 90 minutes overlaps itself |
| 9 | No token budget for agents | — | `maxIterations` bounds turns, not spend |
| 10 | Change-triggered automations do not throttle | — | 1,000 record creates start 1,000 runs, each writing records — the dominant feed-load risk |
| 11 | `web` sits in `AgentToolName` | `authoring/automations/automations.ts` | Belongs to the template agent; must leave the workspace agent's names |
| 12 | `queue` / `integrationDelivery` are requirements with no binding member | `platform-utils/runtime/binding.ts` | Satisfiable only by host loops, which the contract does not express |
| 13 | No workspace carries a seed | no template has `src/+seed.ts`; 287 MB lives in `apps/core/seed` | A standalone workspace starts empty |
| 14 | `presignPut` / `presignGet` unused in OSS | `platform-utils/runtime/binding.ts` | Contract surface nothing exercises |
| 15 | No agent testing story | — | An author cannot exercise an agent without real inference |
| 16 | `agent_run_step` has no retention policy | — | Unbounded growth |
| 17 | The agent plugin is an iframe hosting its own loop, transport, session and data path | `runtime/host-plugin-frame.svelte`; registry in `shared/plugins.ts` | Duplicates what Pod will own; blocks it from using the synced replica and the requestor's scope |
| 18 | Interactive agent runs are unspecified | `server/run/tenant_run.ts` keys `runAutomation` entirely off `automationName` | No ad-hoc run, no client-callable start, no mid-run user turn — a structural assumption, not a missing parameter |
| 19 | `buildDiff` has no subscription filter | `server/collection/sync/sync-endpoints.server.ts` | Every outbox row costs a policy-scoped read per connected client, subscribed or not |

**Already fixed during this work:** `automation_run` was written unelevated, so every scheduled
automation reported failure after running successfully — the run executed, the bookkeeping write was
refused, and the 403 replaced the result.

---

## 7. Takeover map

The regions a migration touches, and what each owns today.

```
packages/pod/src/lib/
├── authoring/
│   ├── automations/automations.ts     defineAutomation overloads · AgentAutomationSpec
│   │                                  · AgentToolName                    ── gaps 2, 11
│   └── workspace/hook-api.ts          BeforeApi: sendNotification, aiInferStructured
│                                                                         ── gaps 3, 5
├── server/
│   ├── collection/hook-api.server.ts  the implementations behind BeforeApi ── gaps 3, 5
│   ├── collection/collection_ops...   the only authorized writer. DO NOT BYPASS
│   ├── collection/sync/*              sync engine — stable except gap 19
│   ├── integrations/tenant-outbox...  the outbox pattern notifications copy
│   ├── run/tenant_run.ts              runAutomation · dispatchRuntimeRun verb switch
│   │                                                                     ── gaps 2, 18
│   ├── run/automation-dispatch...     dead dispatcher                     ── gap 1
│   ├── run/ai_infer.server.ts         one half of the AI surface to collapse
│   └── bootstrap/runtime_request...   route table · RUNTIME_ENDPOINT_HANDLERS
├── remote/ai_infer/*                  the other half of the AI surface to collapse
├── runtime/host-plugin-frame.svelte   the iframe the agent view lives in   ── gap 17
├── vite/compiler/index.ts             filesystem discovery — add +<name>.tool.ts and
│                                      +notifications.ts; generate the unions
├── bin/invocation/                    standalone host                      ── gaps 6, 7, 8
└── host/                              adapters and the host contract

packages/platform-utils/src/
├── runtime/binding.ts                 facility contracts · requiredRuntimeFacilities
│                                                                    ── gaps 4, 5, 12, 14
├── system/workspace-schema.ts         notification · automation_run · integration_outbox
│                                      — add notification_outbox, agent_run_step
└── manifest/types.ts                  ManifestAutomationTemplate — no trigger field ── gap 1
```

**Do not modify** as part of this work: the sync engine under `server/collection/sync/` beyond gap
19's subscription filter, and `collection_ops` — the only authorized writer of collection tables.
Everything else reaches data through it, and `_ops_guard` exists to make that unbypassable.

Core-side counterparts: `apps/core/.../tenant_runtime/bindings.ts` (facility implementations),
`apps/core/src/lib/automation/automation-scheduler.server.ts` (cron registration, gap 1), and
`apps/core/seed/` (gap 13).

---

## 8. Migration stance

**This is a big-bang migration. No legacy implementation is left behind.**

No dual code paths, no compatibility shims, no feature flags gating old behaviour against new, no
deprecated-but-still-working surfaces. When a subsystem is replaced, the thing it replaces is deleted
in the same change — not marked deprecated, not kept "just in case", not left reachable through an
older entry point.

The reason is specific rather than stylistic: nearly every gap in section 6 is something that *looks*
implemented and is not. A dead dispatcher, a table nothing writes, an authoring form that type-checks
and never runs. Leaving replaced code in place is how that class of defect is created, and this
migration touches exactly the areas where it already happened.

Practically: a surface is either fully migrated and tested, or it is not started. A half-migrated
subsystem is worse than an unmigrated one, because the facility gate and the compiler both stop
telling the truth about it.

---

## 9. Delivery plan

### Landed

- `host/` module: `postgresDb`, `localFileStorage`, `s3FileStorage`, `devIdentity`,
  `trustedHeaderIdentity`, `consoleNotifications`, `stubMaps`, `env`, cron matcher
- `pod.host.ts` loader with built-in defaults; `db` resolved through the adapter so `migrate` and
  `seed` follow the configuration rather than diverging from `DATABASE_URL`
- Facility registry replacing the hardcoded db-only set; the gate reflects real configuration
- Pluggable identity; `pod start --dev-identity` and `pod dev`
- Scheduler: cron automations and the integration outbox drain
- The `automation_run` elevation fix (see section 6)

### Phase 0 — finish standalone

Gaps 6, 7, 8. Standalone holds a dedicated `LISTEN norbital_sync` client and installs it through the
existing `setDatabaseNotifications` seam; automations run detached with per-automation in-flight
tracking so the sweep loop stays fast and a slow run cannot stall outbox delivery. Also the
`pod.config.ts` → `pod.host.ts` rename in code.

### Phase 1 — notifications

Gaps 3, 4.

1. `notification_outbox` table and migration
2. Pod writes the `notification` row for `system`, in the caller's transaction; return the real id
3. Queue non-system channels to the outbox; drain through the existing scheduler
4. `defineNotifications` + generated `NotificationChannel` union in `$types`
5. `requiredRuntimeFacilities` emits `notifications`; gate checks channel coverage
6. `notificationProviders()`; `consoleNotifications` becomes a dev provider claiming every channel
7. Core registers its existing senders as providers — send code unchanged

### Phase 2 — agents

Gaps 2, 5, 11, 17, 18, 19.

1. `agent_run_step` as a normal insert-once collection; liveness derived from the newest step
2. Workspace-agent tools: `read_collection` / `write_collection` executors over `collection_ops`
   gated by `access` + `collections`; `defineAgentTool` discovery by `+<name>.tool.ts` suffix;
   generated tool-name and collection unions in `$types`
3. The loop: iterate, route tool calls, insert one step per turn, bound by `maxIterations`, resume
   from `max(sequence)`; scheduler fails runs whose newest step is stale
4. Interactive runs: `agent/start` — unwind `runAutomation`'s dependence on `automationName`
5. Subscription-filtered `buildDiff` (gap 19) — the load fix, and it pays off against agents' record
   writes more than against their transcripts
6. `HostAiBinding` collapses to a single `chat`; `api.ai(...)` replaces `aiInfer` and
   `aiInferStructured`; both are declared by `requiredRuntimeFacilities`
7. `pod sync` validates the agent tool allowlist against real collections
8. Core registers its model adapter as the provider; the agent view becomes a component over synced
   records rather than an iframe. Its template agent stays entirely Core-side

### Phase 3 — event automations and test consolidation

Gap 1, then the suite. Event dispatch has the same shape as integration delivery: one tenant-wide
tailer advancing a cursor and asking the runtime to dispatch, driven by the host's scheduler — never
the per-client sync stream, which would fire once per connected browser. `ManifestAutomationTemplate`
gains a trigger field.

Then restructure `tests/` into named segments with a shared harness, closing the gaps this work
exposes: the compiler, the CLI, the facility gate, the stdio wire protocol, and every facility other
than `db`.

### Sequencing note

Gap 18 is structural rather than additive — `runAutomation` keys entirely off `automationName`, so
interactive runs are not a parameter to add. Under the big-bang stance it must be resolved as part of
Phase 2 rather than after it, or Phase 2 lands a declared-only runtime that has to be reopened
immediately for the agent view.

### Open decision

Seed data lives in Core (`apps/core/seed`, 287 MB), so a standalone workspace starts empty. Whether
templates gain their own `src/+seed.ts` is a product decision, not a technical one, and it is the
only item here that is not simply unbuilt.
