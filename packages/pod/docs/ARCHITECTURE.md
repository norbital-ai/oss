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
│ db · fileStorage · maps · notifications · ai                  │
│ scheduler · integrationDelivery                               │
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

## Host modes

Both modes run the same build and the same facility gate.

|                   | Hosted                | Standalone                   |
| ----------------- | --------------------- | ---------------------------- |
| Runtime transport | framed process I/O    | in-process calls             |
| HTTP socket       | host                  | `pod start`                  |
| Facilities        | host bindings         | `pod.host.ts` bindings       |
| Identity          | trusted host identity | configured identity provider |
| Static build      | served by host        | served by standalone process |

`pod.host.ts` is loaded only by standalone commands. A hosted runtime never reads it.

```ts
import {
	definePodHost,
	devIdentity,
	env,
	notificationProviders,
	postgresDb,
	s3FileStorage
} from '@norbital-ai/pod/host';

export default definePodHost({
	db: postgresDb({ url: env('DATABASE_URL') }),
	identity: devIdentity({
		userId: env('POD_ADMIN_ID'),
		organizationId: env('POD_ORG_ID'),
		organizationName: env('POD_ORG_NAME')
	}),
	fileStorage: s3FileStorage({
		bucket: env('S3_BUCKET'),
		region: env('S3_REGION'),
		endpoint: env('S3_ENDPOINT'),
		accessKeyId: env('S3_ACCESS_KEY_ID'),
		secretAccessKey: env('S3_SECRET_ACCESS_KEY')
	}),
	notifications: notificationProviders(emailProvider),
	ai: modelProvider,
	scheduler: { automations: true }
});
```

## Facility gate

The compiler projects requirements into the manifest. Standalone startup compares them with the
resolved host configuration and refuses to listen if anything is missing.

| Facility              | Required when                                           |
| --------------------- | ------------------------------------------------------- |
| `db`                  | always                                                  |
| `fileStorage`         | a collection contains a file field                      |
| `maps`                | a collection contains a geolocation field               |
| `notifications`       | the workspace declares an external notification channel |
| `ai`                  | an agent automation or `src/+facilities.ts` declares it |
| `queue`               | the workspace declares any automation or integration    |
| `integrationDelivery` | the workspace declares an integration                   |

This makes capability support binary and observable: a workspace either starts with every facility
it requires or does not start.

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

- PostgreSQL's `temporal_tables` extension archives native rows into a typed
  `<collection>_history` table. Historical rows therefore have the collection's queryable column
  shape rather than a JSONB envelope. Pod creates the history tuple descriptor from PostgreSQL's
  catalog so array dimensions, types, collations, nullability, and defaults stay native.
- Generated migrations mirror every column add, alter, rename, and drop into the history table.
  History tables are never rebuilt. A migration locks `approval_request` and refuses to run while
  any approval is non-terminal, so approval rollback never crosses schema versions.
- `audit_event` is the append-only action log, and `agent_run_step` is the append-only AI
  transcript. Neither is a temporal snapshot or rollback source.

The record, typed temporal snapshot, audit event, and sync row share one transaction; an audit
failure rolls the entire mutation back. A PostgreSQL installation hosting Pod must provide the
`temporal_tables` extension before Pod applies its schema.

## Filesystem compiler

The compiler treats the workspace filesystem as the source of truth. One source inventory is shared
across discovery passes, and independent roles are discovered concurrently.

```text
src/
├── +facilities.ts
├── +notifications.ts
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
Duplicate names are compile errors. Notification channels are declared once at
`src/+notifications.ts`. Non-inferable facilities are declared once at `src/+facilities.ts`.

### Capability declarations

`src/+facilities.ts` declares a host capability that source discovery cannot infer. Today that is
direct AI use from deterministic hooks, remotes, or pipelines:

```ts
// src/+facilities.ts
import { defineFacilities } from '@norbital-ai/pod/authoring';

export default defineFacilities({ ai: true });
```

The compiler copies `ai` into the manifest. Hosted and standalone startup then require an AI
binding before accepting traffic. Agent automations imply `ai` automatically, so they do not need
this file. The declaration contains no credentials and does not select a provider.

`src/+notifications.ts` declares the complete set of external channels tenant code may send:

```ts
// src/+notifications.ts
import { defineNotifications } from '@norbital-ai/pod/authoring';

export default defineNotifications({ channels: ['email', 'telegram'] as const });
```

The compiler turns these names into the exact `NotificationChannel` type and the runtime manifest.
Startup verifies that the host covers every declared channel. `system` is built into Pod, is always
available, and cannot be redeclared.

A `+<name>.tool.ts` module defines one opt-in agent tool:

```ts
// src/collections/permits/+check_registry.tool.ts
import { defineAgentTool } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export default defineAgentTool({
	description: 'Check a permit against the tenant registry.',
	input: z.object({ permitId: z.string().uuid() }),
	run: (api, { permitId }) => api.db.permits.findFirst({ where: { norbital_id: permitId } })
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
- exact collection, tool, and notification unions;
- workspace-aware authoring module augmentation;
- an isolated strict TypeScript configuration;
- migration inputs and deployable build metadata.

The generated declarations make collection allowlists, tenant tool names, and notification channels
compile-time exact.

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
                         → host scheduler claim
                         → provider send
                         → delivered | retry | dead-letter
```

Both rows are created in the caller's transaction. A rollback therefore removes the in-app
notification and prevents external delivery. The host receives a recipient user ID and resolves its
own delivery address and preferences.

```ts
// src/+notifications.ts
export default defineNotifications({ channels: ['email', 'telegram'] as const });
```

The compiler adds those values to `NotificationChannel`; `system` is always present and cannot be
declared or shadowed by a host provider.

## Agents

Pod owns the workspace-agent loop. The host AI facility performs model inference only:

```ts
export type HostAiBinding = {
	chat(input: {
		messages: readonly AiMessage[];
		tools?: readonly AiToolSpec[];
		outputSchema?: unknown;
		model?: string;
		profile?: string;
	}): Promise<{
		text: string;
		toolCalls?: readonly AiToolCall[];
		stopReason: 'end' | 'tool_use' | 'max_tokens' | 'refusal';
		usage?: unknown;
	}>;
};
```

Built-in tools are:

- `describe_workspace`;
- `read_collection`, bounded by `collections`;
- `write_collection`, exposed only when `access: 'write'`.

Tenant-defined tools receive the same scoped API as workspace automations. Every read and write
therefore retains policy, hook, approval, version, and audit behavior.

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

`agent_run_step` is append-only. Its `(automation_run_id, sequence)` pair is unique, and database
triggers reject updates and deletes. Messages persist their explicit role; messages, tool calls,
tool results, and errors are individual steps. Both runs and steps carry their requestor owner, so
ordinary policy fallback exposes only the caller's transcripts. Tenant-defined tools receive a
runtime-enforced collection allowlist and read/write mode, not merely a TypeScript hint.

There is intentionally no token stream. Completed steps flow through the ordinary sync engine,
giving reconnect, refresh, offline catch-up, multi-tab convergence, and local querying without a
second transport. `automation_run.status` and the newest step provide liveness.

Interactive runs use the same loop and transcript:

```text
POST /_runtime/agent/start { message, runId? }
```

## Automations and scheduler

An automation has one trigger:

```ts
{ schedule: '0 6 * * *' }
{ trigger: { collection: 'permits', event: 'updated' } }
```

Schedule expressions are validated before the process listens. Scheduled runs are detached from
outbox drains, and one automation cannot overlap itself.

Collection-event dispatch is tenant-wide, not client-driven. The scheduler tails the authoritative
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
