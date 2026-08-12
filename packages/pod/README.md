# @norbital-ai/pod

Pod is the complete framework for a Norbital tenant workspace. It turns a filesystem of models,
relationships, hooks, applications, automations, remotes, and tools into:

- a typed Svelte application;
- a server runtime with authoritative collection operations;
- a policy-scoped local replica and generated client;
- PostgreSQL schema and migration history;
- temporal record history, mutation audit, approvals, and notifications;
- a deployable bundle that can run inside Core or with an explicit self-hosted adapter.

Core is a host for Pod output. Pod does not depend on Core, and a workspace does not change its
tenant code when it moves between hosts.

## The mental model

```text
authored workspace
  src/collections + apps + automation + remotes + tools
             │
             ▼
       Pod filesystem compiler
  validates roles, generates types and assembly,
  derives migrations, builds client and server
             │
             ▼
        one workspace artifact
             │
       ┌─────┴──────────┐
       ▼                ▼
   Core host       self-hosted Pod
       │                │
       └──────┬─────────┘
              ▼
 identity + PostgreSQL + optional host facilities
              │
              ▼
 policy-scoped sync client in the browser
```

Pod owns tenant behavior and tenant data semantics. The host owns the external world: identity,
credentials, database connectivity, object storage, AI providers, maps, outbound delivery, timers,
and process I/O.

## Requirements

- Node.js and pnpm versions supported by this repository;
- Svelte 5 and Vite;
- PostgreSQL 18 or newer for a running workspace;
- PostgreSQL 18 with Pod's provider-portable native history trigger;
- direct workspace dependencies on `svelte`, `zod`, `runed`, `@iconify/svelte`, and `vite`.

Use one of the executable workspaces in
[template_workspaces](../../template_workspaces/) as the starting point. Templates are both examples
and conformance fixtures; they contain the exact dependency and configuration shape expected by the
compiler.

## Workspace layout

```text
workspace/
├── src/
│   ├── collections/
│   │   ├── +relationship.ts                    required, exactly one
│   │   └── <collection>/
│   │       ├── +model.ts                       required per collection
│   │       ├── +hooks.ts                       optional
│   │       ├── +pipelines.ts                   optional
│   │       ├── +integrations.ts                optional
│   │       └── +representation.svelte          optional
│   ├── custom-types/
│   │   └── <lower_snake_case>/
│   │       ├── +definition.ts                  required as a pair
│   │       └── +renderer.svelte                required as a pair
│   ├── apps/
│   │   ├── +<lower_snake_case>.svelte
│   │   └── <group>/
│   │       ├── +group.ts                       optional group metadata
│   │       └── +<lower_snake_case>.svelte
│   ├── automation/
│   │   └── +<lower_snake_case>.ts
│   ├── policies/
│   │   └── +<lower_snake_case>.policy.ts       a role, as code
│   ├── channels/
│   │   └── +<lower_snake_case>.channel.ts      a conversational entry point
│   ├── remotes/
│   │   └── +<lower_snake_case>.ts
│   ├── **/+<lower_snake_case>.tool.ts          agent tool, anywhere under src
│   ├── +seed.ts                                optional
│   └── +env.ts                                 optional
├── .norbital/
│   └── migrations/                             committed
├── package.json
├── pod.host.ts                                 required deployment target
├── tsconfig.json
└── vite.config.ts
```

`src/collections/` and `src/apps/` are required, and a workspace must expose at least one app.
Collection directories are direct children of `src/collections/`. Automations and remotes are flat.
Applications may be grouped hierarchically.

Names come from paths. There is no registry file to maintain:

- `src/collections/work_orders/+model.ts` defines collection `work_orders`;
- `src/apps/operations/+dispatch_board.svelte` defines app `dispatch_board`;
- `src/automation/+daily_digest.ts` defines automation `daily_digest`;
- `src/policies/+sales_rep.policy.ts` defines policy `sales_rep`;
- `src/channels/+sales_desk.channel.ts` defines channel `sales_desk`;
- `src/remotes/+dashboard_summary.ts` defines remote `dashboard_summary`;
- `src/tools/+find_supplier.tool.ts` defines agent tool `find_supplier`.

Other root `+*.ts` roles are rejected. In particular, facilities and notifications are not tenant
registry files: the active host supplies them through `pod.host.ts`.

## Minimal configuration

`vite.config.ts` contains the only framework plugin configuration:

```ts
import { pod } from '@norbital-ai/pod/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [pod()]
});
```

A bundled server dependency that loads a non-JavaScript sidecar at runtime must declare that file
as part of the immutable server artifact. Sources are absolute build-time paths; targets are
validated relative to `output/server`:

```ts
const decoderWasm = decodeURIComponent(
	new URL('../wasm/decoder.wasm', import.meta.resolve('decoder-package')).pathname
);

export default defineConfig({
	plugins: [pod({ serverAssets: [{ source: decoderWasm, target: 'decoder.wasm' }] })]
});
```

The deployed runtime does not receive the build depset, so resolving a package sidecar lazily from
`node_modules` is not a portable substitute.

The authored `tsconfig.json` delegates generated paths and role-local declarations to Pod:

```json
{
	"extends": "./.norbital/tsconfig.json"
}
```

A Core-targeted workspace declares that target explicitly:

```ts
// pod.host.ts
import { definePodHost } from '@norbital-ai/pod/host';

export default definePodHost({ mode: 'core' });
```

Recommended scripts:

```json
{
	"scripts": {
		"sync": "pod sync",
		"sync:watch": "pod sync --watch",
		"check": "pod check",
		"build": "vite build",
		"dev": "pod dev"
	}
}
```

There is no SvelteKit in a tenant workspace: no `svelte.config.*`, route tree, `+page` files,
`$app/*`, or `@sveltejs/kit`. `pod()` installs the Svelte and Tailwind Vite integrations itself.
Pod also imports `@norbital-ai/ui/base.css`; tenant apps must not install a second base stylesheet or
Tailwind plugin.

## Authoring collections

### Models

Every collection owns one `+model.ts`. Declaration order and field kinds drive the default mobile
card, form, and detail experiences. Metadata describes the collection, not its screen layout.

```ts
import { custom, dateRange, defineModel, enums, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		project_name: text().notNull(),
		project_number: text(),
		status: enums(['planned', 'active', 'on_hold', 'complete']),
		schedule_range: dateRange(),
		contract_value: custom('money')
	},
	{
		description: 'Construction projects and their operating context.',
		recordLabel: ['project_number', 'project_name'],
		icon: 'lucide:building-2',
		indexes: [{ columns: ['project_number'], unique: true }]
	}
);
```

Available authoring columns include the Drizzle PostgreSQL basics `boolean`, `integer`, `text`, and
`uuid`, plus Pod's `date`, `timestamp`, `clockTime`, `numeric`, `phone`, `enums`, `dateRange`,
`file`, `geolocation`, and `custom`.

Pod adds the platform record columns, creates the live table, creates a typed temporal history table,
and generates input and row types. Tenant code must not reproduce platform columns or hand-write
collection tables.

### Relationships

The root `src/collections/+relationship.ts` is the single relationship graph. Its generated
`Relationships` type exposes exact collection and column names.

```ts
import type { Relationships } from './$types.js';

export default ((r) => ({
	projects: {
		project_tasks: r.many.tasks()
	},
	tasks: {
		project_tasks: r.one.projects({
			from: r.tasks.project_id,
			to: r.projects.norbital_id
		})
	}
})) satisfies Relationships;
```

Use `through(...)` for many-to-many joins. Wrap an owned child relation in `cascade(...)` only when
deleting the parent must delete the child. Unmarked foreign keys remain restrictive.

### Hooks and mutation rules

`+hooks.ts` owns collection-specific create, update, and delete rules. Import the generated `Hooks`
type from the adjacent `$types.js`; it reflects the actual model.

```ts
import { refuse } from '@norbital-ai/pod/authoring';
import type { Hooks } from './$types.js';

export default {
	update: {
		before: async ({ input, existing, api }) => {
			if (existing.lifecycle === 'PAID') {
				refuse('A paid run is immutable. Correct it with a later adjustment.');
			}

			const next = { ...existing, ...input };
			// `api.db` performs typed server-side reads inside the operation.
			return next;
		}
	}
} satisfies Hooks;
```

Use `refuse(message)` for an expected business refusal whose message should reach the person.
Unexpected exceptions are treated as internal faults and do not leak their message to the browser.

Hook capabilities are deliberately phase-specific:

- before hooks receive transactional database access, file reads, and transactional notification
  writes;
- after hooks receive read-only queries plus explicit elevated `mutate`/`delete` methods for derived
  writes;
- AI is available to server handlers and automations, but not inside the authoritative mutation
  transaction.

All derived mutations still re-enter Pod collection operations. Direct SQL is guarded and cannot
bypass policy, approvals, hooks, history, audit, or sync.

### Collection UI

`+representation.svelte` is the only collection-owned override for create, display, and edit
representation. Its generated `RepresentationProps` type uses the real model and permits a nullable
record for create mode.

Shared collection surfaces come from `@norbital-ai/ui`:

- `@norbital-ai/ui/collection-table`;
- `@norbital-ai/ui/collection-form`;
- `@norbital-ai/ui/collection-kanban`;
- `@norbital-ai/ui/data-renderer`.

Every `CollectionTable` requires an explicit `columns` snippet. Tables do not infer columns and do
not accept a `fields` property. Schema-derived defaults remain available for forms, cards, details,
and individual field rendering.

## Authoring custom types

A filesystem custom type is always a definition/renderer pair:

```text
src/custom-types/project_address/
├── +definition.ts
└── +renderer.svelte
```

`+definition.ts` owns the value schema and uses `defineCustomType`. `+renderer.svelte` owns its UI.
Definitions may compose other filesystem custom-type schemas, but must not import schema authority
from a collection. The compiler discovers and registers both halves; there is no manual custom-type
registry.

## Authoring applications

Any `src/apps/**/+<name>.svelte` file is a complete tenant application. It imports the generated
client and portable UI directly:

```svelte
<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Stack } from '@norbital-ai/ui/layout';

	const projects = client.db.projects.findMany({
		where: { status: { eq: 'active' } },
		orderBy: { project_name: 'asc' },
		limit: 100
	});
</script>

<svelte:head>
	<title>Projects</title>
	<meta name="description" content="Active construction projects" />
	<meta name="pod:icon" content="lucide:building-2" />
</svelte:head>

<Stack>
	<!-- Render projects.current and its loading/error state. -->
</Stack>
```

App title, description, and icon are statically read from `<svelte:head>`. Group metadata belongs in
the group's `+group.ts`. Compose screens with the portable layout primitives `Stack`, `Inline`,
`Cluster`, `Split`, `Grid`, `Columns`, `Cover`, `Center`, and `Frame`. Local scrolling is explicit
with `Bound` and `Scroll`.

The compiler rejects private virtual imports and framework internals from authored application code.
Applications use `$pod/client` and public packages only.

## Authoring policies

A policy is a role, written as code. One file per role in `src/policies/`, flat, named
`+<lower_snake_case>.policy.ts`. The filename is the identity — there is no registry and no id to
keep in sync.

```ts
// src/policies/+sales_rep.policy.ts
import type { Policy } from './$types.js';

export default {
	name: 'Sales representative',
	description: 'Owns their own quotes; reads shared accounts and product data.',
	apps: ['crm_sales'],
	grants: [
		{ collection: 'accounts', action: 'read' },
		{ collection: 'products', action: 'read' },

		// Scoped to the requestor. `${requestor.norbital_id}` binds at evaluation time against the
		// request scope, so this reads *their* quotes, not every quote that has an owner.
		{
			collection: 'quotes',
			action: 'read',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		},
		{ collection: 'quotes', action: 'create' },
		{
			collection: 'quotes',
			action: 'update',
			where: { owner_id: { eq: '${requestor.norbital_id}' } }
		}
	]
} satisfies Policy;
```

Everything cross-referenced here is checked at compile time. `collection` is a `CollectionName`, so a
renamed collection breaks this file rather than silently granting nothing; `apps` are `AppName`s; and
`where` is typed against that collection's row, so renaming `owner_id` is a type error rather than a
filter that matches nothing.

`where` accepts the query operators, minus one: **`RAW` is not in the type.** A raw fragment is a
function, and a policy crosses into storage as JSON — the function is dropped, the conditions arrive
empty, and an empty condition set reads as _unconditional_. A grant that was meant to narrow would
have widened to everything. `PolicyWhere` removes `RAW` outright so the mistake cannot be written.

Policies reconcile into `policy` rows when you migrate, so a fresh database has them and a change to
a role shows up in a diff. A team points at one through `team.policy_id`. Assigning a person to a
team is runtime administration, not authoring — that is the workspace settings surface, not this
file.

Two more things follow from a role being a file rather than seed data. Admin short-circuits every
grant, so a policy describes what a non-admin may do. And the generated `PolicyName` union is what a
channel references, which is why a channel cannot name a role that does not exist.

## The generated client

The compiler creates `$pod/client` with exact collection, relation, mutation-input, remote, and app
types.

### Live reads

```ts
import { client } from '$pod/client';

const orders = client.db.orders.findMany({
	where: { status: { eq: 'open' } },
	with: { customer: true },
	orderBy: { norbital_created_at: 'desc' },
	limit: 25
});
```

A read returns a `RemoteQuery<T>`:

```ts
type RemoteQuery<T> = {
	readonly current: T | undefined;
	readonly loading: boolean;
	readonly error: Error | undefined;
	refresh(): Promise<void>;
};
```

The resource is also awaitable when imperative code needs the first value. Render from `current`;
normal collection changes automatically re-evaluate affected queries, so routine UI code does not
refetch or invalidate.

The generated database API supports typed `findMany`, `findFirst`, grouping, count, history, relation
loading, filtering, sorting, and pagination.

### Optimistic mutations

```ts
await client.db.orders.create({
	customer_id: customerId,
	amount: 1500
});

await client.db.orders.update(orderId, { status: 'approved' });
await client.db.orders.delete(orderId);
```

Mutation availability and input shape incorporate model and hook types. A write applies to the local
optimistic overlay immediately, then the server confirms or rejects it. A rejection removes the
overlay and exposes the server's structured refusal or conflict.

### Remotes

Use a remote when a result is derived server-side and does not map to a normal local collection
query.

```ts
// src/remotes/+revenue_summary.ts
import { defineQueryHandler } from '@norbital-ai/pod/authoring';
import { z } from 'zod';
import type { Api } from './$types.js';

export default defineQueryHandler({
	schema: z.object({ owner_id: z.uuid().optional() }),
	handler: async ({ owner_id }, api: Api) => {
		const total = await api.db.opportunities.count({
			where: owner_id ? { owner_id: { eq: owner_id } } : undefined
		});
		return { total };
	}
});
```

```ts
const summary = client.invoke.revenue_summary({ owner_id });
```

`defineQueryHandler` produces a reactive `RemoteQuery`. `defineCommandHandler` produces a
`Promise` and is for explicit side effects. Both validate input using their declared Zod schema and
run only in the server bundle.

### Files

File fields store document references, not object bytes. Pod's client upload helper sends bytes to
Pod's file routes; Pod owns the `document_asset` record, access checks, lifecycle, and mutation
linkage. The active host only stores and retrieves bytes by the object key Pod assigns.

## Pipelines and integrations

Collection `+pipelines.ts` files define import and export transformations. Import returns model-shaped
rows to be passed through collection operations. Export returns a manifest of named HTML, PDF, CSV,
XLSX, JSON, text, or binary attachments.

Collection `+integrations.ts` files define tenant-side integration behavior:

- the `connection` — a base URL and a _reference_ to the credential that reaches it;
- inbound pull or system-event triggers (`webhook` is declarable but not yet delivered);
- outbound mutation events;
- the transformation from a record event to a delivery payload.

Two collections may name the same integration; they must declare the same connection, compared by
value. Every `{ env: 'NAME' }` reference must be declared in `src/+env.ts`, and every name declared
there must be referenced — both directions are build errors.

Tenant integration code decides what is accepted and what is sent. It does not hold endpoint
credentials or perform any network request. Outbound delivery is claimed from a durable outbox,
retried with backoff, and handed to the host's `integrationDelivery` function together with the
declared destination; `httpIntegrationDelivery()` is the built-in implementation of it. Inbound pulls
are host-driven jobs on the binding's cron schedule, resuming from `integration_cursor`. A
`systemEvent` destination never leaves the pod and reaches the `receive` bindings waiting on it.

## Automations, AI, and agent tools

Automations are files under `src/automation/`. They have either a cron schedule or a collection-event
trigger.

```ts
import { defineAutomation } from '@norbital-ai/pod/authoring';
import type { Api } from './$types.js';

export default defineAutomation({ schedule: '0 6 * * *' }, async (api: Api) => {
	const expired = await api.db.query.quotes.findMany({
		where: { status: { eq: 'sent' } },
		limit: 250
	});
	return { expired: expired.length };
});
```

```ts
export default defineAutomation(
	{ trigger: { collection: 'user', event: 'created' } },
	async (api: Api, { scope }) => {
		await api.db.activities.create({
			subject: `User ${scope.incoming_record.name} joined`
		});
		return { user_id: scope.incoming_record.norbital_id };
	}
);
```

Scheduled and event automations are driven by the host queue. Event cursors are durable and do
not depend on an open browser. The same automation never overlaps itself.

An agent automation declares its task and narrow capabilities:

```ts
export default defineAutomation(
	{ trigger: { collection: 'tickets', event: 'created' } },
	{
		kind: 'agent',
		task: 'Triage the new ticket and assign the correct queue.',
		collections: ['tickets', 'queues'],
		access: 'write',
		tools: ['lookup_service_status'],
		maxTokens: 4000
	}
);
```

An agent tool is a real compiler-discovered file:

```ts
// src/tools/+lookup_service_status.tool.ts
import { defineAgentTool } from '@norbital-ai/pod/authoring';
import { z } from 'zod';

export default defineAgentTool({
	description: 'Look up the current status of a named service.',
	input: z.object({ service: z.string().min(1) }),
	async run(api, { service }) {
		return api.db.query.services.findFirst({
			where: { name: { eq: service } }
		});
	}
});
```

Tool names are exact compiler-generated string unions and must be opted into by each agent
automation. `describe_workspace`, `read_collection`, and `write_collection` are reserved built-in
tools.

Pod owns the agent loop, input validation, collection allowlists, read/write mode, persistence, and
tool execution. The host's AI binding supplies one inference turn at a time. Ordered `AiMessage`
values and nested turn state live directly in the tenant-owned `chat_session` aggregate and reach
clients through one ordinary sync subscription. Agent transcripts are policy-scoped; Core and other
hosts store no transcript.

The tenant-workspace agent is configured separately from scheduled automation in `src/+agent.ts`:

```ts
import type { AgentAutomationSpec } from '@norbital-ai/pod/authoring';

export default {
	kind: 'agent',
	task: 'Assist with this workspace.',
	collections: ['services'],
	access: 'write',
	hostTools: ['sandbox_read']
} satisfies AgentAutomationSpec;
```

If the file is absent, interactive chat still runs — under a fallback profile with `access: 'write'`,
every workspace agent tool, and every host tool the deployment offers. Tools are not the boundary
here and are not meant to be read as one: the agent acts as the signed-in user with that user's
permissions, so policy, hooks and approval gates decide what actually happens. An authored
`src/+agent.ts` wins outright rather than being widened. Host tools are the exception to all of it,
because they carry no requestor and act as a principal the host chooses; a channel run is offered
none of them for that reason. The trade is written out in
[Agent architecture](./docs/AGENT_ARCHITECTURE.md#host-tools).

The Pod shell owns both its floating tenant-workspace entry point and full `/agent` surface.
Assistant and subagent text is written as `streaming` tenant rows and arrives through the ordinary
replica sync connection.

Every agent also reads skills, which are how it learns anything its training data does not contain.
A skill is a directory holding a `SKILL.md` with `name` and `description` frontmatter, in the
[Agent Skills format](https://agentskills.io/specification), plus reference files it loads only when
it needs them. There are two kinds. The ones Pod ships are compiled into the package and present in
every run — `norbital-platform` for how the platform behaves, `authoring-tenant-workspace` for how to
author one. The rest are found by reading a filesystem: a workspace skill under `src/skills/<name>/`,
committed and shared by the tenant, and a personal skill under `.agents/skills/<name>/` on the
filesystem the run executes on, committed nowhere. Personal skills are a self-hosted feature — under
`pod dev` and `pod start` that filesystem is one principal's own, while a host that runs one runtime
per organization has no per-person directory to point discovery at, so it finds none. `list_skills`
and `read_skill` are granted to every agent unconditionally and no spec can withhold them. Names
share one namespace, and precedence runs host, then workspace, then personal.

## Authoring channels

A channel is a conversational way in: someone messages a transport, the agent answers under a named
policy, and the reply goes back out. One file per entry point in `src/channels/`, named
`+<lower_snake_case>.channel.ts`.

```ts
// src/channels/+sales_desk.channel.ts
import type { Channel } from './$types.js';

export default {
	transport: 'telegram',
	policy: 'sales_rep',
	description: 'Customer-facing sales enquiries',
	task: 'Answer questions about quotes and accounts for this customer.'
} satisfies Channel;
```

`policy` is a `PolicyName`, and that is the whole point of the design: a channel runs the agent
**under a declared role**, so a stranger messaging the bot reaches exactly what a sales rep may
reach and nothing else. A channel is not a way around the permission model, and naming a role that
does not exist does not compile.

What the workspace does **not** declare is the credential:

```
message ─▶ [ host process ]  ── proves the wire (bot secret) ──▶ deliver()
                 ▲                                                  │
         botToken lives here                                        ▼
         (pod.host.ts, never                              [ tenant workspace ]
          the workspace bundle)                      agent runs under `policy`
                 ▲                                                  │
                 └──────────── messaging.sendVia ◀── reply ─────────┘
```

Pod serves **no inbound HTTP route** for channels, deliberately. Proving a message really came from
Telegram means checking Telegram's secret, and that credential belongs to whoever holds the wire —
never the tenant, and under Core never even a process with a socket. So the host authenticates the
wire its own way and calls `deliver`; the workspace is handed something already proven, and there is
no public endpoint that could be persuaded to speak for a stranger.

The host side is one line, and it is where the token goes:

```ts
// pod.host.ts
import { definePodHost, messagingProviders, telegramBot } from '@norbital-ai/pod/host';

// Both halves of one wire: `transport` carries replies out, `listen` brings messages in.
const desk = telegramBot({ botToken: process.env.TELEGRAM_BOT_TOKEN!, channel: 'sales_desk' });

export default definePodHost({
	mode: 'self-hosted',
	db: postgresDb({ url: process.env.DATABASE_URL! }),
	// `identity` and `publicUrl` are required too — see Identity below.
	messaging: messagingProviders({ transports: [desk.transport] }),
	channels: desk.listen
});
```

Telegram is built in over long polling, which is why it needs no public URL. A managed host such as
Core can register listeners through its private host-command control plane instead of the
`pod.host.ts` `channels` adapter. The workspace file above is unchanged either way.

## Seed data

An optional root `src/+seed.ts` defines authored bootstrap data. `pod seed` executes the compiled
seed against the configured database and organization. Seed logic is server-only and is separate
from schema migrations.

Use migrations for schema and durable data evolution. Use the seed for a workspace's initial fixture
or template bootstrap.

## What the compiler does

`pod sync`, `pod check`, and builds all invoke the same filesystem compiler. It:

1. discovers roles from their paths;
2. rejects missing, duplicated, misplaced, reserved, or unknown roles;
3. statically validates app metadata and authoring boundaries;
4. assembles the model, relationship, hook, pipeline, integration, app, automation, remote, tool, and
   seed registries;
5. generates exact role-local `$types.js` declarations and `$pod/client`;
6. derives runtime facility requirements from the assembled workspace;
7. generates or updates migration inputs and the committed migration history;
8. runs isolated native TypeScript and Svelte checks;
9. builds separate server and browser environments.

Generated state lives under one root:

```text
.norbital/
├── diagnosis/       structural and type diagnostics, ignored
├── dist/            normal Vite build output, ignored
├── build/           `pod build` standalone output, ignored
├── generated/       compiler assembly, client, manifests, ignored
├── migrations/      generated migration history, committed
├── types/           role-local declarations, ignored
└── tsconfig.json    generated strict TypeScript configuration, ignored
```

Commit workspace source, `pod.host.ts`, and `.norbital/migrations/`. Ignore every other generated
entry. A suitable rule is:

```gitignore
.norbital/*
!.norbital/migrations/
```

Generated files are compiler output, not extension points. Authored `src/**` must never import
`@norbital-ai/pod/authoring/internals`.

## Build artifacts

`vite build` writes the standard deployable artifact to `.norbital/dist/`. `pod build` uses the same
compiler and builder but writes `.norbital/build/` for `pod start`.

An artifact contains:

- the server-only workspace registry, hooks, handlers, automations, tools, and runtime;
- the browser application, Pod shell, UI, and generated HTTP client proxy;
- static assets and a serving entry;
- the workspace manifest and required-facility manifest;
- generated schema functions and post-DDL SQL;
- committed migrations;
- the compiled seed manifest when `src/+seed.ts` exists.

Server-only tenant modules never enter the browser bundle. `pod.host.ts` selects the deployment
target and adapters; it is loaded by standalone commands rather than compiled as tenant source.

## Request and mutation internals

For every protected request:

```text
host identity provider
  → authenticated user and organization
  → trusted or database-resolved base scope
  → workspace request context
  → Pod route
  → policy evaluation
```

The host establishes identity. Pod resolves or validates role, status, team, and organization scope,
then applies the platform policy evaluator. Browser-controlled values never select an administrator
or widen a scope.

Every browser, remote, automation, agent, import, and derived write ultimately enters the same
collection operation:

```text
validate input
  → policy check
  → approval gate
  → before hook
  → authoritative live-table write
  → temporal version
  → audit event
  → sync outbox event
  → after hook / derived operations
  → commit
```

The live record, typed history row, `audit_event`, and `sync_outbox` event are one PostgreSQL
transaction. `_ops_guard` database triggers reject direct tenant-table writes outside collection
operations. `_approval_lock_gate` prevents mutation of a record held by a pending approval.

Approvals do not require schema migrations to wait. A migration may run while records are in flight.
Approval rollback reads the columns that exist on the current migrated live table and restores those
values from the typed history table.

Audit and history are different data:

- `audit_event` is the durable, append-only action ledger: who performed which committed mutation,
  with its before/after details and workspace checkpoint;
- `<collection>_history` is queryable historical record data with the same native columns as that
  collection and a system-validity period;
- `chat_session` is the tenant-owned agent transcript aggregate: ordered messages, nested turns,
  title, terminal state and metered usage travel together.

Do not serialize historical records into a generic audit ledger. History remains typed and tracks
schema changes alongside its live table.

## Access control and approvals

Access control is tenant data in Pod's built-in `user`, `team`, `team_members`, and `policy`
collections. It is not duplicated in models or host configuration.

- an administrator has direct tenant access;
- a non-admin receives active policies through team membership;
- a policy lists accessible applications and collection grants;
- each grant names one collection, one `create`/`read`/`update`/`delete` action, and conditions;
- read conditions become the SQL predicate used by normal queries and sync shapes;
- write conditions evaluate against the incoming and, when applicable, original record;
- a write grant may attach an approval configuration instead of granting the write directly.

This same evaluator protects the browser client, remotes, automations, agents, imports, file metadata,
and sync. Filtering only in an app is never access control.

A gated mutation uses write-then-lock semantics: Pod writes the proposed record through the normal
operation, creates its approval request, and locks that record against further mutation. Approval
advances through configured team steps. Approval finalization unlocks the accepted version;
rejection restores the appropriate typed temporal version and unlocks it. Approval service writes
use a private server-only bypass key and still retain history, audit, and sync behavior.

Some platform collections have intentionally narrower fallback visibility: a person can see their
own notifications, file assets, automation/agent runs, and transcripts, plus the workflow metadata
needed for approvals they can participate in. These are server rules, not client filters.

## Temporal history and migrations

Pod uses its own PL/pgSQL temporal-history trigger so managed PostgreSQL providers do not need a
custom C extension. Every tenant collection has a
`<collection>_history` table whose business and platform columns mirror the live table. Native
history queries expose current and historical record versions in the collection's shape, with
system-period metadata.

Generated migrations mirror add, alter, rename, and drop operations to the history table. They never
destructively rebuild history. JSON serialization happens only at an API boundary where a wire
format requires it; storage remains native and queryable.

Normal workflow:

```bash
pod sync
git add src .norbital/migrations
```

For an explicitly named schema migration:

```bash
pod migration create add_project_risk
```

For a hand-authored data migration:

```bash
pod migration create backfill_project_risk --custom
```

Review every generated migration. Apply committed migrations with `pod migrate`.

## Sync engine

The browser keeps one PGlite database per origin in a SharedWorker. The collection is the unit of
sync.

### Initial and ongoing reads

1. A live query registers the collection shape it needs.
2. Pod serves only rows visible to the requestor's policy scope.
3. The client stores those rows in PGlite and answers filtering, sorting, pagination, and relations
   locally.
4. A server-sent event stream carries collection changes.
5. Changed records are re-read under current policy before delivery; a record that left the visible
   scope becomes a `leave` eviction instead of leaking its new value.

Warm state persists across reloads. A database epoch invalidates physically incompatible client
state. Windowed or otherwise incomplete resident collections fall back to a server query whenever
the local replica cannot answer truthfully.

### Writes and ordering

Optimistic writes live in a separate client overlay. Accepted server versions replace the overlay.
Rejected writes roll it back. `norbital_row_version` detects write conflicts, and `_pod_pending`
persists offline work until it can be retried.

The authoritative transaction appends `sync_outbox` rows ordered by `(xid, seq)`. Horizon gating
uses PostgreSQL snapshot `xmin`, so a later transaction cannot be published ahead of an earlier open
transaction and create a permanent ordering gap.

The transport surface is:

- `GET /_runtime/sync/schema`;
- `POST /_runtime/sync/shape`;
- `GET /_runtime/sync/stream` using server-sent events;
- `POST /_runtime/sync/mutate`.

Standalone uses PostgreSQL `LISTEN`/`NOTIFY` to wake its publisher. A hosted runtime supplies the
equivalent host wake-up seam. The durable outbox, not the notification itself, remains authoritative.

See [Sync engine](./docs/SYNC_ENGINE.md) for protocol details, reset behavior, resource limits, and
documented gaps.

## Notifications and external facilities

Tenant code calls `api.sendNotification(...)`; it does not define a notification provider.

- `system` is Pod-owned: a notification record is written transactionally and sync delivers it;
- every external channel is host-owned: a `notification_outbox` row is written transactionally,
  then the queue job resolves the recipient and invokes the matching provider;
- retries and dead-letter state are durable;
- Pod rejects an external channel that the active host does not advertise.

The same rule applies across facilities:

| Workspace behavior                     | Required host facility                         |
| -------------------------------------- | ---------------------------------------------- |
| Any running workspace                  | `db`                                           |
| A `file()` field                       | `fileStorage`                                  |
| Deterministic automation               | `queue`                                        |
| Agent automation                       | `queue` and `ai`                               |
| Outbound integration                   | `queue` and `integrationDelivery`              |
| External notification call             | matching `messaging` channel at call time      |
| A declared channel                     | `messaging` transport of that name, at startup |
| Geolocation autocomplete or static map | `maps` at call time                            |
| Direct runtime AI call not in manifest | `ai` at call time                              |

Static field and automation requirements are checked before the server listens. Dynamic notification
channels and direct API calls are validated precisely when called.

`maps` is deliberately _not_ a startup requirement of a `geolocation()` field. A stored geolocation
carries its own geometry and formatted address, so reading and rendering one needs no provider — only
edit-time autocomplete and static-map rendering do, and those validate when called. Gating startup on
it blocked two templates from `pod dev` for a dependency they never use.

## Hosting

`pod.host.ts` answers one question: does this workspace run in Core, or does this repository supply
its own host?

### Core target

```ts
import { definePodHost } from '@norbital-ai/pod/host';

export default definePodHost({ mode: 'core' });
```

Core supplies every runtime binding. `pod dev` may run this target locally by emulating Core with
PostgreSQL, local file storage, an interval queue, and the bootstrapped development identity. The two
facilities it cannot hold a credential for — messaging and integration delivery — are stood in for and
written to the console, so a workspace that declares a channel or an integration still starts locally
instead of being refused for a secret no development machine has.

`pod start` deliberately refuses `mode: 'core'`. A production Core artifact must be deployed to
Core; it must not silently turn into a different host.

### Self-hosted target

Self-hosting is explicit and adapter-driven:

```ts
// pod.host.ts
import {
	consoleMessaging,
	definePodHost,
	env,
	emailOtp,
	intervalQueue,
	localFileStorage,
	postgresDb
} from '@norbital-ai/pod/host';

export default definePodHost({
	mode: 'self-hosted',
	db: postgresDb({
		url: env('DATABASE_URL'),
		maxConnections: 20
	}),
	publicUrl: env('POD_PUBLIC_URL'),
	identity: emailOtp({ secret: env('POD_AUTH_SECRET') }),
	fileStorage: localFileStorage({
		directory: '.norbital/storage'
	}),
	messaging: consoleMessaging({ channels: ['email'] }),
	queue: intervalQueue({ intervalMs: 30_000 })
});
```

`db` and `identity` are required. Add only real implementations for the optional `fileStorage`,
`ai`, `messaging`, `maps`, `integrationDelivery`, and `queue` fields. Pod exports
PostgreSQL, local/S3-compatible file storage, trusted-header/development identity, and messaging
composition helpers. AI, maps, and integration credentials remain host-specific contracts; there is
no pretend default provider.

### Identity

Pod owns authentication. The directory is the `user` table, credentials and invitations live in the
tenant database, and the login, code-entry, and invitation-accept pages ship with the runtime — a
workspace author writes no auth code and no auth markup.

`emailOtp({ secret })` is the default and stores no password: the address is the credential. It is a
_descriptor_, not a constructed provider, because sending a code needs the messaging facility and
reading an invitation needs the tenant database — neither reachable from a config file. `pod start`
binds those, so `pod.host.ts` stays data.

`publicUrl` is required. An invitation link has to be absolute, and the token travels by email, so
there is no request to derive an origin from when the link is built.

```ts
identity: emailOtp({ secret: env('POD_AUTH_SECRET') });
```

Bring your own IdP by implementing `HostIdentityProvider` instead:

```ts
identity: {
	name: 'oidc',
	async handleRoute(request) {
		// Consulted before authentication, so a login page is reachable with no session.
		// Return null for "not my route".
	},
	async authenticate(request) {
		// A `HostIdentity` names a user. A `HostVerifiedSubject` — `{ subject: { email } }` — says
		// "I proved this address" and lets Pod resolve it against the directory, honouring a pending
		// invitation. A `Response` challenges (a redirect to your login page). `null` is a bare 401.
	}
}
```

Invite people from the tenant configuration surface, or from the CLI:

```bash
pod invite someone@example.com
```

That mints an invitation and **no account** — an invitation is a claim, not an identity, so a freshly
migrated workspace admits nobody until the address is proven. The token is stored only as a digest;
the plaintext exists once, in the link.

### The queue facility

Cron automations, outbox draining, and event-automation tailing cannot be driven by the runtime: it
has no timer and, in a hosted container, no network. Pod derives the whole job set from the manifest
and hands it to `queue`; the host supplies timing, persistence across restarts, and the guarantee
that one job name never overlaps itself.

```ts
type HostQueue = (jobs: readonly QueueJob[]) => Promise<() => void>;
type QueueJob = { name: string; schedule: string; run(): Promise<void> };
```

`schedule` is a five-field cron expression or `'continuous'` for a drain loop the host paces.

Pod ships **no durable queue**. `intervalQueue()` is a timer, and it is named rather than defaulted
so a deployment running on one says so in its own config: nothing survives a restart, a missed
schedule is never caught up, and two processes against one database will both claim. That is fine
for `pod dev` and a single container, and wrong for anything that must not drop work — point `queue`
at pg-boss or an equivalent there, which is what Core does.

A workspace with automations refuses to start when no `queue` is configured, rather than starting
with schedules that silently never fire.

`s3FileStorage` works with S3-compatible stores such as AWS S3, MinIO, Cloudflare R2, and DigitalOcean
Spaces.

An identity provider implements:

```ts
type HostIdentityProvider = {
	readonly name: string;
	authenticate(request: Request): HostIdentity | null | Promise<HostIdentity | null>;
	handleRoute?(request: Request): Response | null | Promise<Response | null>;
};
```

`handleRoute` may own login, logout, and identity-provider callbacks. `authenticate` returns the user
and organization. A host that is itself authoritative for the complete policy scope may also return
`baseScope`; otherwise Pod resolves it from tenant identity data.

`trustedHeaderIdentity` is for a trusted authenticated reverse proxy. It requires a shared token of
at least 32 bytes and validates:

- `x-norbital-host-token`;
- `x-norbital-user-id`;
- `x-norbital-org-id`;
- `x-norbital-org-name`;
- `x-norbital-base-scope-json`.

The token is required only when this provider is selected. It is not a universal Pod credential.

### Standalone environment

Standalone migration, seed, development, and start commands use:

| Variable           | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `DATABASE_URL`     | PostgreSQL connection used by a Core target and command fallback |
| `POD_HOST`         | loopback listen address: `127.0.0.1`, `::1`, or `localhost`      |
| `POD_PORT`         | listen port                                                      |
| `POD_ORG_ID`       | bootstrap organization UUID                                      |
| `POD_ORG_NAME`     | bootstrap organization name                                      |
| `POD_ADMIN_ID`     | bootstrap administrator UUID                                     |
| `POD_ADMIN_NAME`   | bootstrap administrator display name                             |
| `POD_ADMIN_EMAIL`  | bootstrap administrator email                                    |
| `POD_TEMPLATE_KEY` | seed provenance key                                              |

The standalone runtime only binds loopback. Put an authenticated host or reverse proxy in front of
it; do not expose the process directly.

For a self-hosted target, migrations and seeding use the database URL from `pod.host.ts`, ensuring
`pod migrate` and `pod start` cannot accidentally target different databases.

### Standalone lifecycle

```bash
pod build
pod migrate
pod seed       # only when the authored seed should run
pod start
```

`pod dev` performs build, migrate, and start. `pod dev --seed` also runs the seed. A Core target uses
local Core emulation in development; a self-hosted target retains its declared adapters.

Restart is an ordinary graceful process restart: send `SIGTERM`, then run `pod start` again against
the same `.norbital/build` and database. The sync outbox, automation cursors, integration deliveries,
notifications, approvals, history, and agent steps resume from durable database state.

## CLI reference

| Command                                | Result                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| `pod sync`                             | discover roles, generate assembly/types, check structure, derive migrations |
| `pod sync --watch`                     | repeat authoring compilation and checks on filesystem changes               |
| `pod check`                            | run build-mode TypeScript and Svelte validation                             |
| `vite build`                           | produce the normal `.norbital/dist` artifact                                |
| `pod build`                            | produce the standalone `.norbital/build` artifact                           |
| `pod migration create <name>`          | create a named schema migration                                             |
| `pod migration create <name> --custom` | create an authored data-migration file                                      |
| `pod migrate`                          | apply committed migrations                                                  |
| `pod seed`                             | execute compiled `src/+seed.ts`                                             |
| `pod start`                            | serve a self-hosted artifact                                                |
| `pod dev` / `pod dev --seed`           | build, migrate, optionally seed, and serve locally                          |

`pod platform build` is an internal distribution command, not a tenant workflow.

## Public imports and boundaries

| Import                                 | Intended consumer and purpose                                 |
| -------------------------------------- | ------------------------------------------------------------- |
| `@norbital-ai/pod/authoring`           | tenant server definitions and generated-role types            |
| `$pod/client`                          | compiler-generated tenant client and app loaders              |
| `@norbital-ai/pod/client`              | public reusable client helpers, including files/import/export |
| `@norbital-ai/pod/vite`                | workspace `pod()` plugin                                      |
| `@norbital-ai/pod/host`                | `pod.host.ts` and host adapter authors                        |
| `@norbital-ai/pod/client/platform`     | platform host mounting internals                              |
| `@norbital-ai/pod/client/runtime`      | built runtime client entry                                    |
| `@norbital-ai/pod/authoring/internals` | compiler output only; forbidden in authored `src/**`          |

Portable UI remains in `@norbital-ai/ui`; Pod does not re-export it. Workspaces also import their
peer dependencies directly rather than through Pod.

## Testing and distribution

The OSS Pod package owns its conformance tests. Core is a host and must not be required to prove Pod
semantics.

The suite is organized by boundary:

- `tests/compiler` — file discovery, generated types, build separation, and diagnostics;
- `tests/sync` — shapes, filtered streams, ordering, reconnect/reset, optimistic writes, and policy
  visibility;
- `tests/collection` and `tests/runtime` — authoritative mutations, access control, approvals,
  temporal history, audit, hooks, remotes, agents, and streaming;
- `tests/storage` — file upload/download/delete, authorization, and lifecycle;
- `tests/standalone` — host loading, facility gates, migrations, seed, queue, restart, and
  runnable/non-runnable artifacts.

PostgreSQL end-to-end tests use disposable stock PostgreSQL 18 containers, matching the extension
constraints of managed production providers.
Template builds are executable end-to-end compiler and type fixtures.

The package is published as a normal npm archive. Templates are projected as Git refs named
`refs/heads/templates/<key>`. Each template owns an exact lockfile and Pod version; a tenant fork
starts at an exact template commit and upgrades through an intentional rebase or merge. Template
changes do not propagate invisibly.

## Further documentation

- [Documentation index](./docs/README.md)
- [Architecture](./docs/ARCHITECTURE.md) — detailed Pod/host boundary and runtime invariants
- [Agent architecture](./docs/AGENT_ARCHITECTURE.md) — loop, tools, transcripts, channels, and host boundary
- [Workspace settings](./docs/WORKSPACE_SETTINGS.md) — tenant administration and the host-credential boundary
- [Sync engine](./docs/SYNC_ENGINE.md) — replica protocol and correctness rules
- [Form system](./docs/FORM_SYSTEM.md)
- [Navigation state](./docs/NAVIGATION_STATE.md)
- [Executable tenant templates](../../template_workspaces/)
