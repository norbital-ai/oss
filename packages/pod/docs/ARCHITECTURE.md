# Pod architecture

One architecture. Core and self-host are two hosts. Pod is never the server.

A workspace is **functions**. The compute unit is one durable **step** = one 2s admit. Yield ends
the isolate. The host does not compose leftover rows.

```text
                         BROWSER / CHANNEL
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
   HOST SERVICE             HOST HTTP                HOST SERVICE
   sync SSE                 pages, static,           channel WS
   (LISTEN/NOTIFY)          function POST            (Baileys / Telegram)
         │                       │                       │
         │                  HOST ADMIT                   │
         │                  timeout = host policy        │
         │                  1 in-flight step / tenant    │
         │                       │                       │
         │                       ▼                       │
         │         ONE FUNCTION = ONE DURABLE STEP       │
         │         isolate-vm (Core) / in-process (self) │
         │                       │                       │
         │              ┌────────┴────────┐              │
         │              ▼                 ▼              │
         │           return            yield effect      │
         │           (done)         (this step finished) │
         │                              │                │
         │                     DBOS next step            │
         │                                               │
         └───────────────────────┬───────────────────────┘
                                 │
                       TENANT ISOLATE = 0
                       when no step is running
```

The boundary is strict:

> Anything that reads or writes tenant records runs in Pod. Anything that touches the outside
> world runs in the host.

Core is one host. A self-hosted process is another. The same compiled workspace runs in both.

## Runtime boundary

```text
┌─ TENANT WORKSPACE (Pod) ────────────────────────────────────────┐
│ authoring   collections · hooks · apps · remotes · automations │
│ data        collection operations · policy · approval · audit  │
│ sync        local replica · change feed · live queries         │
│ agents      loop · tools · transcript                          │
│ notify      transactional system notifications and outbox      │
│                                                               │
│ one step, then 0 · no listen · no SSE · no WS                 │
│ no credentials · no outbound network · no host knowledge      │
└──────────────────────────┬─────────────────────────────────────┘
                           │ facility refs (during an admitted step)
┌──────────────────────────┴─────────────────────────────────────┐
│ HOST                                                          │
│ db · fileStorage · maps · messaging · ai                     │
│ queue · integrationDelivery                                   │
│                                                               │
│ owns HTTP, static, SSE, channel sockets, LISTEN/NOTIFY        │
│ owns credentials, OpenRouter, admit/kill, the cap             │
│ DBOS owns which durable step runs next                        │
└────────────────────────────────────────────────────────────────┘
```

Pod owns the tenant-record half because it has the workspace registry, requestor policy scope,
hooks, operation guard, approval gates, temporal versioning, and audit trail. A host writing tenant
rows directly would bypass those invariants.

The host owns the outside-world half because a hosted tenant step can execute without network
access or credentials. Core injects facility refs into isolate-vm. Self-host calls the same
bindings in process.

Pod deliberately targets PostgreSQL. The sync ordering contract depends on transaction IDs and
snapshot horizons, and workspace constraints depend on PostgreSQL extensions. `HostDbBinding`
chooses where PostgreSQL lives, not which database engine Pod uses.

Timeout is host policy on admit. The guest reads `remainingMs()` from the admit the host attached;
it never invents a budget. Core’s host policy is 2_000 ms. The reference host (`pod start`) reads
`timeoutMs` from `pod.host.ts` and defaults to the same number as its own policy.

## How yielding works

Authoring looks like a normal `await`. Compute is a finished step plus a later step. The isolate
never waits on a model.

`api.infer` is on `BeforeApi`. There is no second authoring API for “yield.”

```text
  STEP N (tenant, 2s)
       handler runs from the top
       completed effects return from the log
       api.infer has no result
       throw AutomationEffectYield
       │
       ▼
  isolate disposed          ← this step is OVER
       │
       ▼
  STEP N+1 (host facility, not tenant isolate)
       OpenRouter / settle receipt effect
       │
       ▼
  STEP N+2 (tenant, 2s)
       NEW isolate, same handler from the top
       stored result returns
       handler continues until the next infer or return
```

Rules:

- Yield **ends** the tenant step. It is not a pause inside the isolate.
- The next tenant step is a **new** admit, scheduled by DBOS.
- Replay is how `await api.infer()` stays a single authoring line. The prefix before that infer
  runs again; it must still fit in 2s or the step fails.
- Writes in the current transaction **roll back on yield**. Terminal writes happen on the step
  that returns.
- `ai.prompt` (authored `api.infer`) and `ai.turn` (agent loop) are the same yield kind.
- If the step never yields and does not return in 2s, kill and fail. No leftover cursor.

## Authoring

File: `src/automation/+<name>.ts`. Compiler registers `export default`.

```ts
import { defineAutomation } from '@norbital-ai/pod/authoring';

export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{
		description: '…',
		handler: async (api, context) => {
			const rows = await api.db.query.quotes.findMany({ … });
			const note = await api.infer({ prompt: '…' }); // yield = this step ends
			await api.db.update({ collection: 'quotes', id, data: { … } });
			return { summary: { … } };
		}
	}
);
```

What an author does **not** write: `runStep` names, resume tokens, `nextOffset`, sockets, SSE, or
credentials. `DBOS.runStep` is host-only. There is no automation-to-automation invoke; authors
compose via shared `src/lib` and by writing rows that fire other event triggers.

| File | API | Role |
| ---- | --- | ---- |
| `src/automation/+<name>.ts` | `defineAutomation` | scheduled / change-triggered handler |
| `src/channels/+<name>.channel.ts` | `defineChannel` | inbound agent over host transport |
| `src/remotes/+<name>.ts` | `defineQueryHandler` / `defineCommandHandler` | one-shot invoke |
| `src/collections/<c>/+hooks.ts` | `before` / `after` | inside the collection function’s 2s |
| `src/collections/<c>/+pipelines.ts` | import / export transforms | inside import/export’s 2s |
| `+<name>.tool.ts` | `defineAgentTool` | agent/infer tool; inside that step |
| `src/mcp/+<name>.mcp.ts` | MCP server allowlist | host facility, not a guest listen |

Agent authoring is `src/+agent.ts` plus `src/channels/+<name>.channel.ts`, not a public remote.
`defineAutomation` does not take `kind: 'agent'`. Interactive start is the workspace shell
(`agent/start`); channel start is host delivery after inbound persist.

One-shot work **fails** if it cannot finish in 2s. No `nextOffset`. Hooks and pipelines are not
their own admits.

## Same Pod everywhere

The compiled bundle is the same functions. Core loads them in **isolate-vm** and calls a function
export. Self-host is a machine the user provides; a host process (`pod start` or their own) loads
the same bundle **in-process** and admits the same functions. Authors write one workspace. There
is no self-host runtime fork.

MicroSandbox is not the function guest. It stays for untrusted shell and build (`pod check`,
host-tool `sandbox_*`).

## Bundle

The built guest is lightweight invokable functions (`handlePodRequest`, `handlePodHostCommand`,
`register*`). It must not be “a server.” HTTP, listen, static assets, SSE, and timeout belong to
the host. `pod start` is the reference host.

### How the same artifact runs

Authors never target an isolate. They write ordinary TypeScript and Svelte under `src/`. Vite /
Rolldown (not esbuild) emits one server file, `output/server/index.js`. That file is the deployment
unit for both hosts.

```text
src/**  +  Pod compiler
        │
        ▼
Vite / Rolldown
  externals: HOST_IO_NODE_BUILTINS only
  (fs, crypto, async_hooks, path, buffer)
        │
        ▼
output/server/index.js
        │
   ┌────┴────────────────────┐
   ▼                         ▼
Core host                 Self-host (`pod start`)
isolate-vm                Node import()
handlePodDispatch         native node: resolution
loader answers leftover   same function exports
  node: (see below)       same admit / timeout policy
dispose after the step
```

Vite marks only HOST_IO_NODE_BUILTINS external — not every `node:` specifier. Leftover `node:`
imports are answered by Core's isolate loader: host-provided `util` / `stream` / `zlib` / `assert`
via `createRequire`; isolate-local `path` / `buffer` / `crypto` / `async_hooks`; artifact CJS/WASM
for `pdq-wasm`; ESM leftover `fs` is denied, while `createRequire` `fs` reads the sealed artifact
only. Stream/EventEmitter's CJS default is an isolate-local constructor with a prototype so pngjs
`util.inherits` works; the host still provides named `stream` / `zlib` / `util` exports.
`inherits` and `promisify` stay isolate-local.

Core never `import()`s the bundle into the host process. isolate-vm calls `handlePodDispatch`.
There is no guest HTTP listener and no `serve.mjs`. Self-host (`pod start`) is a native Node
`import()` of the same file. Do not resurrect `unenv`.

MicroSandbox is not this path. It stays for untrusted shell and `pod check`.

## What happens if you write a tight loop

A `while (true) hash()` or a hook that chews 700 rows in one `batchHandler` never yields. The host
**kills** the isolate when the timeout fires. An uncommitted transaction rolls back. The function
fails. Do not raise the timeout. An unbounded loop *inside one record’s hook* still fails.

`createMany` / `updateMany` / import / export / inbound fail if they cannot finish in one admit.
A smaller payload is a **new** call, not an offset into the original array.

## Queueing physically prevents a 2s lock

- One in-flight **step** per tenant.
- Fast path: slot free → run now (page load, single create).
- If the slot is taken, the next admit **waits**, then runs. There is no second product.
- Timeout **disposes** the isolate. The slot frees. The next step runs.
- Infer, search, and email are **not** tenant steps — the host does them between admits, so a
  model wait cannot hold the slot.
- No continuous poll jobs. A wake fires because DBOS scheduled the next step or a cron fired.

The isolate fleet equals in-flight steps, not open tabs. Host SSE and channel sockets are host
services; they do not pin a guest.

## Deployment targets

`pod.host.ts` makes the target explicit. It is not tenant source and the filesystem compiler does
not bundle it.

|                         | Core                                                                       | Self-hosted                                      |
| ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ |
| `pod.host.ts` mode      | `core`                                                                     | `self-hosted`                                    |
| Runtime transport       | Host calls a function export in isolate-vm; facilities are injected refs   | Direct in-process call; facilities in process    |
| HTTP and static assets  | Core                                                                       | `pod start`                                      |
| Sync SSE / channel WS   | Host services, tenant-bound                                                | Host services on `pod start`                     |
| Facilities and identity | Core runtime bindings                                                      | `pod.host.ts` providers                          |
| Local development       | `pod dev` emulates Core                                                    | uses the declared providers                      |
| Production `pod start`  | refused                                                                    | allowed after the facility gate                  |

A Core workspace needs only a marker:

```ts
import { definePodHost } from '@norbital-ai/pod/host';

export default definePodHost({ mode: 'core' });
```

An independent deployment provides the complete host:

```ts
import {
	definePodHost,
	env,
	messagingProviders,
	postgresDb,
	s3FileStorage,
	trustedHeaderIdentity
} from '@norbital-ai/pod/host';

export default definePodHost({
	mode: 'self-hosted',
	db: postgresDb({ url: env('DATABASE_URL') }),
	identity: trustedHeaderIdentity({ token: env('POD_TRUSTED_HOST_TOKEN') }),
	fileStorage: s3FileStorage({
		bucket: env('S3_BUCKET'),
		region: env('S3_REGION'),
		endpoint: env('S3_ENDPOINT'),
		accessKeyId: env('S3_ACCESS_KEY_ID'),
		secretAccessKey: env('S3_SECRET_ACCESS_KEY')
	}),
	messaging: messagingProviders({ channels: [emailProvider], transports: [telegram] }),
	ai: modelProvider,
	queue: intervalQueue()
});
```

There are no implicit production defaults and configurations are never merged. A missing
`pod.host.ts` is an error. Core never reads self-hosted providers from the tenant bundle; its
runtime installs the same binding interfaces directly.

## Facility gate

The compiler projects requirements that are structurally knowable into the manifest. Self-hosted
startup compares them with `pod.host.ts` and refuses to listen if anything is missing.

| Facility              | Required before startup when              |
| --------------------- | ----------------------------------------- |
| `db`                  | always                                    |
| `fileStorage`         | a collection contains a file field        |
| `ai`                  | an automation calls `api.infer` or an agent profile needs inference |
| `queue`               | an integration outbox or pull is compiled |
| `integrationDelivery` | an integration is compiled                |
| `messaging` transport | a channel declares it in `src/channels`   |

`queue` is infrastructure crons only — integration outbox, pulls, notification drain. It is not
how functions run. Automations, agents, pages, and collection operations are admitted functions.

Direct calls that cannot be inferred without executing tenant code are checked at the call site.
`api.infer(...)` requires an AI binding. An external `api.sendNotification(...)` requires a
`messaging` binding that advertises that channel. Failure occurs before Pod writes an outbox row.
A channel declared in `src/channels/` is the exception: its `transport` is knowable from source, so
it is checked at startup against the host's `listTransports()` rather than at the first message.
There is no parallel tenant capability declaration and no provider name in the manifest.

File hooks never receive a host storage key directly. `readFileAsset` first resolves the tenant's
`document_asset` row and applies the requestor-or-validated-host-bypass ownership boundary. Hosts may
also expose immutable, versioned inspection facts for an asset. `readFileAssetInspection` keeps the
single-record path; `readFileAssetInspections` accepts at most 512 ids, resolves them with one
ordered tenant query, applies the same authorization to every result, and then performs one aligned
host call. Duplicate ids and cache misses remain aligned with the inputs. An inaccessible or missing
asset fails before the host is called, and a malformed host response fails closed. Batch hooks may
therefore reuse trusted facts without moving tenant policy, geolocation, duplicate detection, audit,
or derived writes into the host; a cache miss still falls back to authoritative byte inspection.

## Request lifecycle

```text
browser request
  → host admit (timeout = host policy)
  → identity provider
  → buildCtx() resolves requestor and organization scope
  → runWithWorkspaceContext()
  → sync | collection operations | files | remotes | agents
```

Every client and agent mutation flows through collection operations:

```text
validate input
  → policy check
  → approval gate
  → before hook
  → authoritative write
  → temporal version
  → audit event
  → sync outbox
  → after hook
  → commit
```

`_ops_guard` rejects tenant-table writes that bypass this path.

Temporal row state and audit are deliberately separate:

- Pod's provider-portable PL/pgSQL temporal trigger archives native rows into a typed
  `<collection>_history` table. Historical rows therefore have the collection's queryable column
  shape rather than a JSONB envelope. Pod creates the history tuple descriptor from PostgreSQL's
  catalog so array dimensions, types, collations, nullability, and defaults stay native.
- Generated migrations mirror every column add, alter, rename, and drop into the history table.
  History tables are never rebuilt. Migrations may run while approvals are non-terminal: rollback
  selects the current table's columns from the correspondingly migrated typed history table, so
  added, altered, renamed, and removed fields follow the current schema without a separate payload
  migration.
- `audit_event` is the append-only action log. Agent messages live in the tenant-owned conversation
  collections described in [Agent architecture](./AGENT_ARCHITECTURE.md); neither is a temporal
  snapshot or rollback source.

The record, typed temporal snapshot, audit event, and sync row share one transaction; an audit
failure rolls the entire mutation back. Pod installs the native history function with its schema;
the PostgreSQL provider needs no custom extension.

Bulk `createMany` and `deleteMany` keep that same collection-level atomic boundary. Hooks and policy
checks run once per record in caller order by default. A create hook may opt into a `batchHandler`;
then `createMany` calls it once with the caller-ordered batch inside that same transaction, while
ordinary single-record create continues to use `handler`. A batch before hook must return exactly one
payload per input in the original order. PostgreSQL statements are chunked inside the single
transaction with a 60,000 bind-parameter budget (headroom below PostgreSQL's 65,535 limit).
Create roots derive their chunk from the inserted column count and cap it at 5,000; delete roots use
independent 1,000-id select/delete chunks. Integration outbox, sync outbox, and audit ledger inserts
each derive their own chunks from their statement's parameter shape. They are not lockstep 1,000-row
batches: one caller batch can become several root statements, a different number of feed statements,
and a different number of audit statements without weakening all-or-nothing commit semantics.
When an authenticated host-bypass caller requests only created ids and the collection has no
per-record or integration effects, Pod may keep the full inserted rows inside PostgreSQL and build
the same complete audit snapshots there. This projection is limited to driver-equivalent scalar,
JSON, enum, date, timestamp, and system-range columns; numeric, binary, vector, array, or
workspace-defined custom driver types retain the ordinary full-row return-and-audit path.

The payload must finish in one 2s admit. There is no leftover composer and no `nextOffset`. A
smaller payload is a new call.

Inbound integration imports use the same one-shot rule. The host stages a validated provider
delivery in `integration_inbound_event`. The admitted function runs the pipeline and persists in
2s, or it fails. Pipeline output is persisted before the first write so a retry cannot rerun
author code or commit a prefix twice.

## Filesystem compiler

The compiler treats the workspace filesystem as the source of truth. One source inventory is shared
across discovery passes, and independent roles are discovered concurrently.

```text
src/
├── +seed.ts
├── collections/
│   ├── +relationship.ts
│   └── permits/
│       ├── +model.ts
│       ├── +hooks.ts
│       ├── +pipelines.ts
│       ├── +integrations.ts
│       ├── +representation.svelte
│       └── +check_registry.tool.ts
├── automation/
│   └── +permit_triage.ts
├── apps/
├── remotes/
└── custom-types/
```

Agent tools use the `+<lower_snake_case>.tool.ts` suffix and may live anywhere under `src/`.
Duplicate names are compile errors. `+notifications.ts` and `+facilities.ts` are not roles and are
rejected as unknown workspace files. Host capabilities exist only at the host boundary.

A `+<name>.tool.ts` module defines one opt-in agent tool:

```ts
// src/collections/permits/+check_registry.tool.ts
import { defineAgentTool } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export default defineAgentTool({
	description: 'Check a permit against the tenant registry.',
	input: z.object({ permitId: z.string().uuid() }),
	run: (api, { permitId }) =>
		api.db.query.permits.findFirst({ where: { norbital_id: { eq: permitId } } })
});
```

The filename supplies `check_registry`. An interactive agent profile in `src/+agent.ts` may list
`tools: ['check_registry']`; discovery does not grant every agent every tool. The compiler rejects
duplicate and built-in names, generates an exact tool-name union, and registers the module.
Runtime exposes only tools selected by the profile, validates input through the tool's Zod
schema, and restricts `api.db` to that profile's collection allowlist and read/write mode.

`pod sync` emits:

- the runtime workspace registry;
- client and server assembly;
- exact collection and agent-tool unions;
- workspace-aware authoring module augmentation;
- an isolated strict TypeScript configuration;
- migration inputs and deployable build metadata.

The generated declarations make collection allowlists and tenant tool names compile-time exact.

## Sync engine

The authoritative transaction writes `sync_outbox` beside the record and audit event.
`sync_outbox.xid` and `sync_outbox.seq` form the cursor:

- `seq` orders writes within a transaction;
- `xid` prevents a later-committing transaction from being skipped;
- rows emit only below `pg_snapshot_xmin(pg_current_snapshot())`.

The browser keeps a PGlite replica. Shape requests fetch policy-visible collection pages; the host
SSE stream carries committed diffs. A physical database epoch invalidates replicas after restore or
re-provision.

`sync/shape`, `sync/head`, `sync/schema`, `sync/mutate`, and `sync/diff` are one-shot functions.
`shape` paging stays as **separate** one-shot calls (`nextCursor` is a new function, not a resume).
`sync/stream` is a **host service**, not a guest function. The host listens on Neon and writes SSE
events. When a frame needs a policy-scoped read, the host admits `sync/diff` (2s, isolate → 0)
and then writes the event. The guest never holds the socket.

Each stream sends its materialized collection set. The server advances across the whole outbox but
performs policy-scoped diff reads only for subscribed collections. This keeps cursor continuity
without paying `rows × clients` for irrelevant collections.

When a client materializes a new collection, it freezes its global cursor until catch-up completes,
then adds the collection and replays from that cursor. This closes both the subscription race and
the stale-page-after-delete race without a second cursor system or client tombstones.

The host installs a dedicated PostgreSQL `LISTEN norbital_sync` connection. Isolation is binding,
not a VM per tab: authenticate the session first, bind the stream to `claims.organizationId`, and
subscribe that connection to that org’s LISTEN only.

## Notifications

`system` is owned by Pod. External channels are owned by host providers.

```text
api.sendNotification(...)
  ├─ system → notification row → sync → in-app client
  └─ external channel → notification_outbox
                         → host queue claim
                         → provider send
                         → delivered | retry | dead-letter
```

Both rows are created in the caller's transaction. A rollback therefore removes the in-app
notification and prevents external delivery. The host receives a recipient user ID and resolves its
own delivery address and preferences.

```ts
await api.sendNotification({
	recipient_user_id: userId,
	subject: 'Permit approved',
	message: 'Your permit is ready.',
	channels: ['system', 'email']
});
```

`system` needs no host binding. Before any external outbox row is written, Pod requires the active
host's `messaging` binding and verifies that every requested channel appears in what its
`listChannels()` returns. A Core provider and a `pod.host.ts` provider satisfy the same interface.

`listChannels()` is a call, not a field, for the same reason `listTransports()` is: a facility
binding reaches a tenant runtime through a proxy that answers every property get with a call
forwarder, so a data field on a binding is a function inside a hosted isolate and an array only
under `pod start`.

Due-ness is the database's clock: `available_at` defaults to the database's `now()` and the claim
compares against `now()` too, so a queued notification is never hidden by the gap between a runtime
process and its database.

### In-app

The `notification` collection replicates like any other. The permission guard scopes it to
`recipient_user_id`, so a browser holds only its own; `notification_outbox` is excluded from the
replica DDL entirely, since a browser can act on none of it.

The workspace shell renders the bell (`ui/shell/notifications-menu.svelte`), supplied to
`WorkspaceShell` as a snippet — the shell component has no data layer, and what is unread is a
question only the runtime holding the replica can answer. It is live through the sync engine and
nothing else: the read is the ordinary cached `findMany`, and a diff applied to the replica re-fires
exactly it. There is no poll and no second stream.

Marking read is the one write no policy grants. A system collection has no author to declare it
mutable, and no author would think to write a grant for "seen" — so it is a named exception
(`SELF_SERVICE_WRITE_COLLECTIONS`), narrow on three axes: this collection, this recipient, and a
payload touching nothing but `read_at`. It is decided against the row already loaded rather than as
a reduced condition, because the mutation path applies those to nothing.

## Agents

The agent **loop lives in Pod** (`agent-loop.server.ts`). Each iteration is one admitted step.
`await infer` yields; the isolate is disposed; the host runs the model; DBOS admits a new isolate
for the next turn. Interactive start is the workspace shell (`agent/start`). Channel start is host
delivery after inbound persist. Agent is not an API-client remote. There is no in-guest loop that
holds one HTTP request for the whole conversation — that is the 2s lock. The loop is still Pod’s.

The host AI facility performs one model-inference turn at a time and may provide trusted tools
through a default-deny binding. The host does not own or persist a transcript.

Interactive chat and declared channels use the same loop implementation and `chat_session`
transcript. Messages and nested turns are stored directly in one `chat_session` aggregate, then
reach the browser through one ordinary policy-scoped sync subscription rather than an
agent-specific stream. There is no agent-chat SSE. Token streaming, if added, is host ↔ browser
while the isolate is 0.

Automations are not agent sessions. They are deterministic handlers; when one needs model
judgement it calls `api.infer({ prompt, schema?, tools?, collections?, images? })` inside the handler.
That is the same host `chat` as the agent: optional schema, optional images, optional named workspace
tools. Always a normal chat session. No `write_collection`, `spawn_subagent`, sandbox, authoring, or
MCP; it does not own a `chat_session` transcript. The handler is bounded to 64 `api.infer` calls and
100,000 prompt characters per invocation.

See [Agent architecture](./AGENT_ARCHITECTURE.md) for execution entry points, transcript ownership,
host-tool authorization, channel continuation, UI behavior and conformance coverage.

## Automations

An automation has one trigger:

```ts
{ schedule: '0 6 * * *' }
{ trigger: { collection: 'permits', event: 'updated' } }
```

The handler is a function. The host admits it with a timeout. If the handler awaits `api.infer`,
the step yields, the isolate is disposed, the host runs the model, and DBOS admits a new isolate
for the next tenant step. Writes before a yield roll back; the terminal writes commit when the
function returns.

Schedule expressions are validated at build/startup. Collection-event admission is tenant-wide, not
client-driven: one bounded function tails the authoritative outbox and advances
`_norbital_automation_cursor`. Opening another browser cannot duplicate a run. Interactive chat and
channel inbound start the same way: persist the user turn, then admit the step.

Integration and notification outboxes drain as infrastructure crons on the `queue` facility, with
claim leases and bounded retry. Inbound integration is one 2s function or fail. `intervalQueue` is
a development timer for those crons. It loses work on process death. It is not how functions run.

## File storage

The host stores bytes. Pod owns `document_asset`, access control, and lifecycle:

```text
upload → host fileStorage.put → document_asset insert with owner_user_id
failure after put → host fileStorage.delete cleanup
delete → verify owner_user_id → host delete → document_asset delete
```

Hook and automation code reads assets through `api.readFileAsset`, which resolves metadata in Pod
and obtains bytes through the host binding.

## Conformance tests

Pod conformance belongs in OSS because all behavior above is Pod-owned. Core tests only need to
prove that its adapters satisfy these public bindings.

The suite is organized by architecture boundary in `packages/pod/tests/README.md` and covers:

- compiler discovery and generated type checking;
- sync shape, filtered streams, mutation, reconnect, reset, and policy visibility;
- mutation, approval, access-control, temporal history, and audit atomicity;
- standalone facility acceptance and refusal;
- file byte storage plus Pod metadata authorization;
- agent tool execution and step-level transcript delivery through sync.

Database conformance runs against disposable PostgreSQL 18 instances and exercises the compiled
tenant runtime artifact, not internal mocks.
