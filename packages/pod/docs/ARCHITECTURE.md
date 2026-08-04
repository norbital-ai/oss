# Pod architecture

Pod is a complete, self-contained tenant workspace runtime. A host supplies facilities; it does not
own tenant behavior.

The boundary is strict:

> Anything that reads or writes tenant records runs in Pod. Anything that touches the outside
> world runs in the host.

Core is one possible host. A self-hosted process is another. The same compiled workspace runs in
both, with no source changes and no host-specific tenant APIs.

## Runtime boundary

```text
┌─ TENANT WORKSPACE (Pod) ────────────────────────────────────────┐
│ authoring   collections · hooks · apps · remotes · automations │
│ data        collection operations · policy · approval · audit  │
│ sync        local replica · change feed · live queries         │
│ agents      loop · tools · transcript · resume                 │
│ notify      transactional system notifications and outbox      │
│                                                               │
│ no credentials · no outbound network · no host knowledge      │
└──────────────────────────┬─────────────────────────────────────┘
                           │ facility bindings
┌──────────────────────────┴─────────────────────────────────────┐
│ HOST                                                          │
│ db · fileStorage · maps · messaging · ai                     │
│ queue · integrationDelivery                                   │
│                                                               │
│ owns credentials, outbound sockets, timers, and process I/O   │
└────────────────────────────────────────────────────────────────┘
```

Pod owns the tenant-record half because it has the workspace registry, requestor policy scope,
hooks, operation guard, approval gates, temporal versioning, and audit trail. A host writing tenant
rows directly would bypass those invariants.

The host owns the outside-world half because a hosted tenant runtime can execute without network
access or credentials. Hosted bindings cross the runtime wire; standalone bindings run in process.

Pod deliberately targets PostgreSQL. The sync ordering contract depends on transaction IDs and
snapshot horizons, and workspace constraints depend on PostgreSQL extensions. `HostDbBinding`
chooses where PostgreSQL lives, not which database engine Pod uses.

## Deployment targets

`pod.host.ts` makes the target explicit. It is not tenant source and the filesystem compiler does
not bundle it.

|                         | Core                                                       | Self-hosted                                      |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `pod.host.ts` mode      | `core`                                                     | `self-hosted`                                    |
| Runtime transport       | Host proxies browser HTTP into the guest; facilities over host-owned stdio | HTTP on a loopback socket; facilities in process |
| HTTP and static assets  | Core                                                       | `pod start`                                      |
| Facilities and identity | Core runtime bindings                                      | `pod.host.ts` providers                          |
| Local development       | `pod dev` emulates Core                                    | uses the declared providers                      |
| Production `pod start`  | refused                                                    | allowed after the facility gate                  |

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
| `ai`                  | an agent automation is compiled           |
| `queue`               | any automation or integration is compiled |
| `integrationDelivery` | an integration is compiled                |
| `messaging` transport | a channel declares it in `src/channels`   |

Direct calls that cannot be inferred without executing tenant code are checked at the call site.
`api.ai(...)` requires an AI binding. An external `api.sendNotification(...)` requires a
`messaging` binding that advertises that channel. Failure occurs before Pod writes an outbox row.
A channel declared in `src/channels/` is the exception: its `transport` is knowable from source, so
it is checked at startup against the host's `listTransports()` rather than at the first message.
There is no parallel tenant capability declaration and no provider name in the manifest.

## Request lifecycle

```text
browser request
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

The filename supplies `check_registry`. An agent automation must list
`tools: ['check_registry']`; discovery does not grant every agent every tool. The compiler rejects
duplicate and built-in names, generates an exact tool-name union, and registers the module.
Runtime exposes only tools selected by the automation, validates input through the tool's Zod
schema, and restricts `api.db` to that automation's collection allowlist and read/write mode.

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

The browser keeps a PGlite replica. Shape requests fetch policy-visible collection pages; the SSE
stream carries committed diffs. A physical database epoch invalidates replicas after restore or
re-provision.

Each stream sends its materialized collection set. The server advances across the whole outbox but
performs policy-scoped diff reads only for subscribed collections. This keeps cursor continuity
without paying `rows × clients` for irrelevant collections.

When a client materializes a new collection, it freezes its global cursor until catch-up completes,
then adds the collection and replays from that cursor. This closes both the subscription race and
the stale-page-after-delete race without a second cursor system or client tombstones.

Standalone installs a dedicated PostgreSQL `LISTEN norbital_sync` connection into the same runtime
notification seam used in hosted mode. Idle streams issue no polling queries.

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

Pod owns the loop, tool dispatch, runs, conversations, messages, channel bindings, authorization,
replication and UI. The host AI facility performs one model-inference turn at a time and may provide
trusted tools through a default-deny binding. The host does not own or persist a transcript.

```ts
export default defineAutomation(
	{ schedule: '0 6 * * *' },
	{
		kind: 'agent',
		task: 'Draft renewals for permits expiring within 14 days.',
		collections: ['permits', 'permit_renewals'],
		access: 'write',
		tools: ['check_registry'],
		maxIterations: 12,
		maxTokens: 40_000
	}
);
```

Interactive chat, agent automations and declared channels use the same loop and transcript model.
Messages are stored as ordered `AiMessage` values in `chat_message` under a `chat_session`, then
reach the browser through ordinary policy-scoped sync rather than an agent-specific stream.

See [Agent architecture](./AGENT_ARCHITECTURE.md) for execution entry points, transcript ownership,
host-tool authorization, channel continuation, UI behavior and conformance coverage.

## Automations and the queue

An automation has one trigger:

```ts
{ schedule: '0 6 * * *' }
{ trigger: { collection: 'permits', event: 'updated' } }
```

Schedule expressions are validated before the process listens. Scheduled runs are detached from
outbox drains, and one automation cannot overlap itself.

Collection-event dispatch is tenant-wide, not client-driven. A queue job tails the authoritative
outbox and advances `_norbital_automation_cursor`; opening another browser cannot duplicate a run.
Integration and notification outboxes drain independently with claim leases and bounded retry.

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
