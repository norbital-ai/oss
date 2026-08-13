# Authoring a tenant workspace

The mental model, and the four principles the authoring surface is designed around. The
[README](../README.md) is the reference for each role; this document is the _why_, and the rule for
deciding where something new belongs.

## The one-sentence model

> **A workspace declares what it is. The host supplies what it needs. Pod owns everything in between.**

Everything below follows from that split. When you cannot decide where something goes, ask which of
the three owns it: is it a property of this workspace (declare it), a credential or a socket or a
clock (the host supplies it), or behaviour every workspace shares (Pod already owns it, and you should
not be writing it).

## The pillars, and where the line falls

Eight things a workspace declares. Everything to the right of the line is supplied, not written — and
the set of facilities is closed, so there is no authoring surface for a ninth.

```text
      YOU DECLARE (in src/)                POD OWNS                THE HOST SUPPLIES
 ──────────────────────────────── │ ──────────────────────── │ ────────────────────────
  collections/  +model.ts         │  authentication          │  db          (required)
                +hooks.ts         │  sessions, invitations   │  fileStorage
                +integrations.ts  │  policy enforcement      │  ai
                +pipelines.ts     │  approvals + audit       │  maps
  policies/     +<n>.policy.ts    │  temporal history        │  messaging
  channels/     +<n>.channel.ts   │  sync + local replica    │  queue
  automation/   +<n>.ts           │  the agent loop          │  integrationDelivery
  remotes/      +<n>.ts           │  collection operations   │  agentTools
  apps/         +<n>.svelte       │                          │
  custom-types/ +definition.ts    │  ── you never write ──   │  declared in pod.host.ts,
  **/+<n>.tool.ts                 │     any of this          │  never in the workspace
  +env.ts       (names, not values)
 ──────────────────────────────── │ ──────────────────────── │ ────────────────────────
   compiles into the manifest          runs on every host        differs per deployment
```

The same bundle runs on Core and on `pod start`; only `pod.host.ts` differs. That is the test for
whether something belongs on the left: if moving hosts would change it, it is not workspace source.

A worked example of each pillar lives in the [README](../README.md) — models, hooks, relationships,
apps, custom types, remotes, policies, channels, automations, agent tools, and integrations. The
templates in [template_workspaces](../../../template_workspaces/) are the executable version of the
same thing, and are conformance fixtures as well as examples.

## Four principles

### 1. Declarative — the filesystem is the registry

Names come from paths. There is no registry file, no `index.ts` to keep in step, and no place for a
declaration to drift from the thing it declares.

| File                                                         | Declares                                   |
| ------------------------------------------------------------ | ------------------------------------------ |
| `src/collections/work_orders/+model.ts`                      | collection `work_orders`                   |
| `src/collections/work_orders/+hooks.ts`                      | its mutation rules                         |
| `src/collections/+relationship.ts`                           | the whole relationship graph (exactly one) |
| `src/apps/operations/+dispatch_board.svelte`                 | app `dispatch_board`                       |
| `src/automation/+daily_digest.ts`                            | automation `daily_digest`                  |
| `src/remotes/+dashboard_summary.ts`                          | remote `dashboard_summary`                 |
| `src/policies/+field_agent.policy.ts`                        | policy `field_agent`                       |
| `src/channels/+sales_desk.channel.ts`                        | channel `sales_desk`                       |
| `src/**/+find_supplier.tool.ts`                              | agent tool `find_supplier`                 |
| `src/skills/<name>/SKILL.md`                                 | skill `<name>`                             |
| `src/custom-types/money/+definition.ts` + `+renderer.svelte` | custom type `money`                        |
| `src/collections/work_orders/+integrations.ts`               | its inbound and outbound bindings          |
| `src/+env.ts`                                                | the names this workspace needs from a host |

**App and representation media.** App identity is a static `<svelte:head>`: literal `title`,
`description`, `pod:icon`, and optional static `pod:thumbnail` / `pod:banner` URLs. Media is
optional — the shell draws a same-size icon fallback in the thumbnail slot. The collection-owned
`+representation.svelte` may declare a static `pod:banner` for the record detail sheet header.
Template images ship under `assets/` and are referenced as `/api/template-seed-assets/<key>/<path>`
(see [apps-and-server-roles.md](../../../skills/authoring-tenant-workspace/references/apps-and-server-roles.md)).
The workspace directory renders each application group as one horizontal row: visible thumbnails are
prioritized, later cards load lazily, and nested groups become their own rows. The clickable
“Applications” sidebar section label is the stable route back to that directory.
The website gallery marketing image is separate: declare it once as `assets/thumbnail.svg` (see
[template-repository.md](../../../skills/authoring-tenant-workspace/references/template-repository.md#marketing-thumbnail-declare-once)).

Adding a file adds the thing. Deleting it removes the thing. Renaming it renames the thing. A role
file whose name Pod does not recognise is a compile error rather than a file that silently does
nothing.

**Skills extend what the agent knows.** A skill is a directory under `src/skills/<name>/` holding a
`SKILL.md` with YAML frontmatter. The format follows the
[Agent Skills specification](https://agentskills.io/specification): required `name` and
`description`, optional `license`, `compatibility`, and a flat `metadata` map, plus reference files
under the directory that the agent loads on demand through `read_skill`. Markdown is not importable,
so the compiler inlines workspace skills into the generated bundle at compile time. Host skills
shipped inside `@norbital-ai/pod` share the same namespace; a workspace skill whose name collides
with a host skill is refused rather than merged. A third place exists that a workspace does not
author: `.agents/skills/<name>/` on the filesystem a run executes on, committed nowhere. That one is
personal only where the filesystem is — under a self-hosted `pod dev` or `pod start`, whose process
serves one principal — and a host that runs a shared runtime per organization has nothing per-person
to point it at, so it finds none. It loses a name collision to both of the others, so authoring a
workspace skill is also how a tenant settles an answer for everyone in it.

Frontmatter is validated against the same rules the host-side generator applies:

- **`name`** must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, be at most 64 characters, and equal the
  directory name (`src/skills/<name>/`).
- **`description`** is required, non-empty, and at most 1024 characters.
- **`compatibility`**, when present, is at most 500 characters.

Diagnostic codes: `SKILL_NAME_INVALID` (bad name or name/directory mismatch),
`SKILL_FRONTMATTER_INVALID` (missing or malformed frontmatter, unsupported keys, empty description,
or length overrun), `SKILL_DUPLICATE` (two workspace skills share a name), `SKILL_NAME_RESERVED`
(name is already shipped by Pod).

**Policies are declarations; membership is not.** A permission set is a property of the workspace, so
it lives in source and shows up in a diff. Who holds it changes at runtime, so `team`, `team_members`,
and `team.policy_id` stay database rows. Reconciliation matches policies by key and never deletes an
undeclared row or flips `is_active` — a deploy must not revoke access nobody asked to revoke.

**A gated grant names its approvers by team name.** A write can be routed through approval instead of
applied directly, and the teams that may approve it are named by `team.name`:

```ts
{
	collection: 'variation_requests',
	action: 'create',
	where: ownVariation,
	approval: {
		id: '019f6f10-0001-7000-8000-000000000003',
		name: 'Field operations variation approval',
		steps: [
			{
				id: '019f6f10-0001-7000-8000-000000000103',
				name: 'Field operations controller review',
				approvers: ['Field Operations Controllers'],
				description: 'Controller verifies scope change and photo evidence.'
			}
		]
	}
}
```

A name, not a `team.norbital_id`: a team is a runtime row, so an id belongs to one particular database
and cannot be declared. `pod migrate` resolves the names against the tenant it is reconciling.

Three things follow, and they are the reason the shape is what it is:

- **`id` on the flow and on each step is carried, never regenerated.** An in-flight `approval_request`
  resolves against those ids; a fresh one strands every request already raised.
- **A name no team holds is refused**, naming the policy, the grant and the team, and the migration
  rolls back. The alternative — storing the grant with `approval_config: null` — reads to the guard as
  a direct write, which is a permission change nobody reviewed.
- **On a tenant with no teams at all**, the reference is deferred rather than refused, because
  `pod migrate` legitimately runs before anything seeds a team. The gate is still stored, so the write
  is still blocked; it simply has no approvers until the teams exist. Reconciliation is idempotent, and
  `pod seed` reconciles again once it has created them.

`steps` and `approvers` are non-empty in the type. A flow with no steps resolves as already-approved,
and a step with no approvers is one nobody can act on — neither reads like a mistake in a diff.

### 2. Type safety — the generated types are the contract

Every role directory gets a `$types.d.ts`. Import from it and the workspace's own schema is bound:

```ts
// src/collections/quotes/+hooks.ts
import type { Hooks } from './$types.js';

export default {
	create: {
		before: {
			description: 'Opens a quote against an active account and numbers it for the year.',
			handler: async ({ input, api }) => {
				// `input` is the quotes create input; `api.db.query.accounts` is exact.
			}
		}
	}
} satisfies Hooks;
```

Every declaration carries a mandatory `description`, and hooks and pipelines are always
`{ description, handler }` — there is no bare-function form. The description is not a comment: it is
compiled into the manifest, which is all the Workspace Studio has to explain a workspace to somebody
who will never open its source.

You rarely need to name a type at all. `defineAutomation`, `defineQueryHandler`, and
`defineCommandHandler` default their schema generic to the compiler-merged workspace schema, so an
unannotated `api` is already exact:

```ts
export default defineAutomation(
	{ trigger: { collection: 'quotes', event: 'created' } },
	{
		kind: 'deterministic',
		description: 'Recomputes the account pipeline total whenever a quote is raised against it.',
		handler: async (api, { scope }) => {
			// `scope.incoming_record` is a quotes row. `'quotez'` above would not compile.
		}
	}
);
```

The generated unions — `CollectionName`, `PolicyName`, `AgentToolName`, `AppName` — are what make a
cross-reference checkable. An agent that names a collection it cannot reach, or a policy naming a
collection that does not exist, fails at compile time.

### 3. No footguns — the wrong thing does not compile, and the ambiguous thing does not exist

The surface is designed so that mistakes surface at their cause rather than downstream:

- **A misspelled name is a compile error, not an empty result.** A trigger on `'quotez'`, a grant on
  `'accountz'`, an agent tool that does not exist — all rejected before anything runs.
- **A `where` is checked against its own collection's row.** A condition naming a column another
  collection has would otherwise compile and then match nothing, reading as a grant while granting
  access to no rows.
- **A malformed cron expression fails at startup**, naming the automation, rather than never firing.
- **A workspace refuses to boot when a facility it needs is absent** — schedules that silently never
  fire are worse than a process that will not start.
- **Every runtime invocation has a universal two-second execution budget.** Admission and cold boot
  happen before that clock starts; reads, writes, hooks, remotes and each automation step all share
  the same cap and every attempt is billable to the tenant. Do not hide unbounded work in a handler.
- **An automation may outlive one invocation without outliving the serverless model.** The runtime
  persists one trigger receipt, replays the handler deterministically, and yields at `api.ai`. The
  host performs the spend-gated inference outside the guest, settles the result under a stable
  effect identity, and a later capped invocation resumes the handler. Writes before a yield roll
  back; the final writes, run telemetry and terminal receipt commit atomically. Authors still write
  an ordinary async handler. Core uses DBOS as the sole automation orchestrator: the tenant receipt
  is the source of truth, while workflow recovery, bounded concurrency, per-tenant serialization and
  fair admission are host work. pg-boss is not an automation scheduler or worker.
- **A seed payload key that is not a column aborts the seed.** A `+seed.ts` record is a plain record,
  so a typo or a column the model renamed cannot be caught by the compiler. It is caught before the
  first write instead: `pod seed` names the step, the key, how many rows carry it and the closest real
  column, then writes nothing — not even the `clearBefore` deletes. This used to be a silent drop, and
  a seed that wrote `user_name` instead of `name` produced a tenant full of users with a NULL name that
  nobody could sign in as, reporting success the whole way.
- **There is one way to do each thing.** No parallel mechanism to choose between, and no
  configuration that only matters in one deployment.

Where a foot-gun cannot be removed, it is named. `intervalQueue()` is a timer with no durability, so it
is an explicit opt-in rather than a default — a deployment running on one says so in its own config.
The seed check has one exemption for the same reason: a **sidecar** key is one the caller consumes
itself before the plan is executed (Core reads `document_asset.metadata.seed_asset` to upload the file
first), and it must be declared as `collection.key` exactly, with a written reason, which the executor
prints on every run.

**One known limit.** A `before` hook that returns a _spread_ — `{ ...input, no_such_column: 'x' }` —
compiles, because TypeScript does not apply excess-property checking to an object literal built from a
spread. A bare literal with the same mistake is rejected. This is a compiler limitation rather than a
loose type: the payload type itself is exact, and the same key assigned to `WorkspaceInsert<'quotes'>`
directly is an error. The mistake is caught at runtime with a 400 naming the field and listing every
valid field and relation for the collection, so it fails loudly — just one layer later than the rest of
the surface.

### 4. Simplicity — the smallest surface that is still honest

Pod ships the parts every workspace would otherwise write badly, and a workspace author never sees
them:

- Authentication, sessions, invitations, and the login / code-entry / accept-invite pages.
- Collection operations, policy enforcement, approvals, audit, and temporal history.
- The sync engine and the policy-scoped local replica.
- The agent loop and its tools.

If you find yourself writing auth, a permission check, an audit trail, or a login form, stop — that is
Pod's, and hand-rolling it means it is not covered by the guarantees above.

## Where does a new thing go?

```
Is it data shape or behaviour of this workspace?
  → declare it: a collection, hook, policy, automation, remote, app, tool, skill, or custom type.

Does it need a credential, an outbound socket, a mailer, a model, or a clock?
  → the host supplies it. Declare the need; never the secret.
      · a fixed capability every host provides  → a facility (db, fileStorage, ai, maps,
        messaging, queue, integrationDelivery). The set is closed — there is no authoring surface
        for a new one, because Core must satisfy it generically for every tenant.
      · a call to one specific third party      → an integration: `+integrations.ts` declares the
        connection and the credential *reference*, `src/+env.ts` declares the name;
        `integrationDelivery` makes the call host-side.

Does it need business logic with typed input and output?
  → a remote: `src/remotes/+<name>.ts`.

Is it authentication, permissions, audit, history, or sync?
  → Pod already owns it. Do not write it.
```

## Integrations — talking to one specific third party

`src/collections/<name>/+integrations.ts` declares both directions for one collection. The connection
is written here, next to the bindings that use it:

```ts
import { defineConnection } from '@norbital-ai/pod/authoring';
import type { Integrations } from './$types.js';

const billing = defineConnection({
	baseUrl: 'https://api.stripe.com',
	authentication: { type: 'bearer', token: { env: 'STRIPE_KEY' } }
});

export default {
	stripe: {
		connection: billing,
		send: {
			upsert: {
				request: { method: 'POST', path: '/v1/customers' },
				on: 'create',
				transform: ({ output }) => output[0]?.attachments[0]?.content
			}
		},
		receive: {
			invoices: {
				pull: { schedule: '*/15 * * * *', path: '/v1/invoices', cursorQuery: 'starting_after' }
			}
		}
	}
} satisfies Integrations;
```

Two collections may name the same integration; they must then declare the same connection, which is
compared by value, so writing it twice is fine and disagreeing is a build error.

**Outbound.** A mutation matching `on` writes a row to a transactional outbox in the same transaction,
so a delivery is never queued for a write that rolled back. The host drains it: the collection's
`export` pipeline runs, the binding's `transform` shapes the result, and the declared destination —
URL, method, headers, and the _names_ of the secret headers — goes to `integrationDelivery` with it.
`httpIntegrationDelivery()` is the built-in implementation and needs no per-host configuration. A
failure retries with capped backoff and dead-letters after ten attempts.

**Inbound.** A `pull` binding is a job on its declared cron schedule: the host fetches with the
connection's credential, hands the body to the collection's `import` pipeline, and writes the rows it
returns. The resume point lives in `integration_cursor`, read before the call and written after the
rows land, so a restart resumes and a crash re-pulls a page rather than skipping one.

**`systemEvent` is a workspace talking to itself.** A `send` with a `systemEvent` destination never
leaves the pod; it reaches every `receive` binding waiting on that exact event name. A receive waiting
on an event nothing emits is refused at startup, naming the binding — the two halves are matched by
string, and a typo used to produce silence rather than an error.

**`webhook` is the push half, and it is not a Pod route.** A binding declares where the signature and
the event id are found, and the _name_ of the signing secret:

```ts
receive: {
	rfi: {
		webhook: {
			authentication: {
				type: 'hmac-sha256',
				secret: { env: 'REPORTS_WEBHOOK_SECRET' },
				signatureHeader: 'x-reports-signature'
			},
			eventIdHeader: 'x-reports-event-id'
		},
		input: z.object({ rfi: z.object({ number: z.string(), title: z.string() }) })
	}
}
```

The endpoint belongs to the host, not to the workspace: verifying an HMAC means holding the sender's
secret, a tenant holds none, and under Core the isolate has no socket to be signed at. A host supplies
`webhooks` in `pod.host.ts` — `httpWebhookListener({ port })` mounts one route per declared binding
and needs no other configuration — and Pod verifies the signature against the named secret _before_
the delivery crosses in, so a listener cannot skip the check. A workspace that declares a webhook and
a host that supplies no listener is a startup warning, not a silent no-op.

**Providers that sign more than the body declare a `timestamp`.** Stripe signs `<timestamp>.<body>`
and sends `stripe-signature: t=<timestamp>,v1=<hmac>`; every default here is that scheme, so declaring
it empty is enough. A provider that sends the timestamp in a header of its own sets `header`, and one
that joins the two differently sets `separator`.

```ts
webhook: {
	authentication: {
		type: 'hmac-sha256',
		secret: { env: 'STRIPE_WEBHOOK_SECRET' },
		signatureHeader: 'stripe-signature',
		timestamp: { toleranceSeconds: 300 }
	},
	events: ['charge.succeeded'],
	eventType: { path: 'type' }
}
```

Declaring it is also what buys a **replay window**. The timestamp is inside the signed string, so it
cannot be edited without breaking the digest, and a delivery further than `toleranceSeconds` from now
— in either direction — is refused. Five minutes is the default. A binding that declares no
`timestamp` signs the raw body exactly as before and has no window: a captured delivery stays valid
for the life of the secret, which is the reason to declare one.

**`events` is a filter, and it needs `eventType` to be one.** `eventType` names where the delivery
writes its own type — `{ header: 'x-github-event' }` or a dotted path into the body — and only that
source is read, so a delivery cannot pick which of two the filter sees. A delivery whose type is
absent or undeclared is rejected before it reaches the pipeline. Declaring `events` without
`eventType` is a build error rather than a narrowing that silently accepts everything.

Every delivery is staged in `integration_inbound_event` under the declared event id (or a digest of the
raw body), then synchronously checked against the binding's `input` before it is acknowledged. A provider
redelivery therefore finds the same receipt instead of importing another page. An input refusal is marked
terminal with no rows, and accepted deliveries are progressed by the continuous import worker.

The worker claims one receipt at a time, runs its pipeline once, saves the resulting rows, and commits
one bounded `createMany` chunk plus its offset in the same transaction. A lost lease resumes at that
offset; it never reruns the pipeline or leaves a partially committed chunk. Transient failures wait with
bounded backoff, while input refusal is terminal. Do not expect a large receive binding to finish during
the webhook request: every Pod runtime read/write step is kept below two seconds, and progressive
progress happens through durable worker invocations. Receipts are swept after 30 days, keeping the newest
thousand however old they are — long past any provider retry horizon, because forgetting a receipt is
the same as being willing to import it again.

## Secrets

A workspace never holds a secret value, only a reference — and it declares the names it will
reference in `src/+env.ts`:

```ts
import { defineEnv } from '@norbital-ai/pod/authoring';

export default defineEnv({
	private: { STRIPE_KEY: { description: 'Stripe restricted API key' } }
});
```

The declaration is checked in both directions: referencing a name that is not here fails the build,
and declaring a name nothing references fails too — `manifest.secrets` is what an operator provisions
against, so an unreferenced entry asks for a credential no code path reads. Between them, a reference
spelled differently from the declaration cannot reach production as a 401.

The reference compiles into the manifest; the host resolves it at call time (`process.env` under
`pod start`, its own secret store elsewhere). Tenant code runs in an isolate with no network under
Core, so it could not make the authenticated call even if it held the key.

## The two deployments are the same workspace

A workspace does not change when it moves between hosts. Same source, same manifest, same auth path:

|                               | Core          | Standalone (`pod start`)                       |
| ----------------------------- | ------------- | ---------------------------------------------- |
| Authoring, policies, agent    | identical     | identical                                      |
| Auth logic and prebuilt pages | identical     | identical                                      |
| Facility _implementations_    | Core supplies | `pod.host.ts` supplies                         |
| Integration queue             | pg-boss       | operator's binding (`intervalQueue()` for dev) |
| Automation orchestration      | DBOS          | host-provided durable automation protocol      |
| Organization selector         | Core          | n/a — one workspace                            |

`pod.host.ts` is the only file that differs, and it is data rather than setup code — adapters and
descriptors are values, so a host configuration stays readable, diffable, and type-checked.

## Getting a workspace running

```bash
pod sync          # generate types and derive migrations from the filesystem
pod check         # compile the workspace and report structural errors
pod dev           # build, migrate, and serve with a loopback development identity
pod invite you@example.com   # mint a founding invitation (self-hosted)
```

`pod dev` supplies `db`, `fileStorage`, `queue`, a console-only `messaging`, and a console-only
`integrationDelivery`, and nothing else. A workspace with an agent automation refuses to start under
it, because `ai` is a _static_ requirement — which is the intended answer, not an inconvenience: the
alternative is a development run that fails at the first inference call, far from the cause.

The two console facilities are there for the same reason: `pod dev` holds no sockets and no endpoint
credentials, and both a declared channel and a declared outbound integration are static startup
requirements, so without a stand-in a workspace that merely _declares_ one cannot be run locally at
all. `consoleMessaging()` covers every transport the workspace's channels declare;
`consoleIntegrationDelivery()` is its counterpart for outbound integrations and logs what would have
been sent rather than throwing, so a local run leaves a readable log instead of an outbox that
retried ten times and dead-lettered. A deployed host has to supply both for real — the startup check
below is against the host's list, and `pod dev`'s is generous by design.

`maps` and notification channels are not static requirements and never gate startup. Nothing in the
manifest implies them: a stored geolocation carries its own geometry and address, and a notification
channel is chosen at call time. Both validate when called.

A **channel** transport is the opposite, and does gate startup. `src/channels/+<name>.channel.ts`
names its `transport` in source, so it is knowable before anything is served — and the failure it
prevents is silence rather than an error: a wrong name means the channel simply never carries
anything, noticed only when somebody expected a reply. A workspace naming a transport its host does
not supply refuses to boot, naming the channel and listing the transports that are available.

Delivery has two halves and they are not symmetric. The **reply** leaves through the `messaging`
facility (`sendVia`), so it needs nothing from the workspace beyond the transport name. The **inbound**
half is host-process code — `channels` in `pod.host.ts`, a function handed `deliver` that returns a
stop function, exactly like `queue`. Pod serves no inbound HTTP route for channels on purpose:
proving a message really came from Telegram means checking Telegram's secret, and the credential
belongs to whoever holds the wire open, which is never the tenant. `telegramBot()` supplies both
halves for Telegram over long polling; a host declaring a channel and supplying no listener is warned
at startup, because a channel that can only speak looks exactly like a broken one.

The declaration has three channel-specific choices: `audience`, the admission budget for a public
profile, and whether groups are disabled, always active, or active only on mention/reply. DMs,
administrator transcript access, account assignment for authenticated profiles, and the runtime
concurrency ceiling are platform invariants rather than extra switches.

```ts
// Public customer support: no account, bounded before a model run.
export default defineChannel({
	transport: 'whatsapp',
	policy: 'customer_support',
	description: 'Public customer support over WhatsApp.',
	audience: 'public',
	rateLimits: { perSenderPerMinute: 8, totalPerMinute: 300 },
	groupMessages: 'disabled'
});

// Internal/BCA-style profile: every sender is an assigned existing account.
export default defineChannel({
	transport: 'whatsapp',
	policy: 'field_ops_contractor',
	description: 'Assigned contractor field support.',
	audience: 'authenticated',
	groupMessages: 'mention_or_reply'
});
```

An authenticated sender must be an active human in an active team holding the declared policy, with
a verified identity for that transport in `user.channels`. A match keeps the human as the requestor
for `${requestor...}` policy placeholders while retaining the channel profile's policy as the
capability ceiling. An unknown sender gets the deterministic registration instruction and no model
run. A public sender needs no user row and runs as the reconciled channel principal.

Transcript visibility is fixed: administrators can read every transcript; a member can read their
own web conversations and authenticated channel DMs, plus authenticated groups whose profile policy
their active team holds. Public channel transcripts are administrator-only. Every channel transcript
and every other person's transcript is read-only in the Agent UI.
