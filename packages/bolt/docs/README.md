# Bolt

Bolt declares, compiles and runs a workspace. Authors write typed declarations and generator
bodies; the compiler produces one artifact, and a host activates that artifact in a scoped service
graph. The manifest defines the schema; committed `migrations/` files describe how stored data reaches it.

`bolt build` generates the next editable SQL migration when the declared schema changes, then replays the complete
history against a fresh database and compares it with the declaration. Commit the SQL, `snapshot.json`,
`migrations.lock.json` and the generated `physical.json` proof together. `bolt check` verifies an existing history
and its physical definitions at every prefix. Regenerate the proof through the normal build. A destructive step requires its explicit
acceptance line; a table or field's `was` hint preserves its data by renaming it. Hosts apply the artifact's verified
files with checksums and one transaction per file before activating the release. Applied files never change.

Replay compares the physical columns, constraints, indexes and functions with an independent build of the declared
schema. Removing an `ADD COLUMN` from edited SQL fails that comparison. The verified lock also binds each migration
prefix's physical schema; activation refuses live schema drift even when every applied SQL checksum still matches.
The generated proof stores shared native definitions once and expands each prefix before checking its hash;
this reduces artifact reads without changing the verified schema or migration ledger.

Review the operational hazards in each SQL step as well as its data acceptance. Adding a column or constraint takes
a table lock; an ordinary index build blocks writes and scans the table. Proven integer widening uses `ALTER TYPE`
to preserve stored values, but can rewrite the table and rebuild indexes under an exclusive lock. Hosts bound lock
waits and roll back a file if its lock cannot be acquired. `CONCURRENTLY` is refused because files run atomically.

Run `bolt build --squash=release_name` to create a verified schema baseline for a complete prefix. Use lowercase
letters, digits and underscores in the name. Its receipt binds the exact original filenames,
checksums and replayed schema; the original SQL stays under `migrations/archive/` and the alternative baseline under
`migrations/squashes/`. Commit both directories and the updated lock. A fresh database runs the longest verified
baseline. A database partway through the original files finishes those files; a database on an earlier baseline
runs the original suffix after that baseline. The ledger records only the SQL each database actually executed, so a
second squash preserves older histories. Data transformations and unclassified executed SQL cannot be squashed
into a schema baseline. If those occur later in the chain, the compiler squashes the preceding safe schema prefix
and retains the suffix unchanged. That prefix replays its original DDL in one verified file, preserving historical
definitions the suffix needs; a chain containing only supported schema DDL can use the smaller declared-schema
baseline. Verification still compares the complete chain with the declared schema.

An existing application database without a migration ledger reports an empty ledger and physical drift; activation
refuses it. The host does not adopt its schema or fabricate applied receipts. Preserve a backup and the genuine
deployment history first. Reconstruct committed SQL that reproduces its live prefix and verify that replay, then
copy the data through a reviewed migration into a newly verified database. Validate the copied data and switch
connections atomically under the database owner's maintenance procedure. Manual external adoption is unsupported.
This workflow assumes `public` is the active schema for both replay and host connections.

## Terms

Each word names one thing:

| Term        | Means                                                                                                                | Where                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Environment | An operating environment: local, staging or production, and a tenant environment inside one.                         | The operator CLI that resets and operates environments; never a workspace setting. |
| Secrets     | Encrypted values stored in the tenant database, read by server code.                                                 | `src/+secrets.ts` with `secrets({ NAME: { label } })`.                             |
| Server code | Transforms, queries, automations, syncs, integrations and page loaders.                                              | The `ctx` each receives; declarations from `@norbital-ai/bolt`.                    |
| Page SDK    | What browser-side page code calls.                                                                                   | `@norbital-ai/bolt/page`, imported in pages as `$bolt`.                            |
| Device      | What the shell running the page provides: location, notifications, push, background notices, opening external links. | `bolt.device` in pages; a shell installs `window.boltDevice`.                      |
| Shell       | The container a workspace runs in, which implements Device.                                                          | The web shell built into Bolt; native apps from `@norbital-ai/app-shell`.          |
| Host        | The server that runs workspaces: a hosting platform or a self-hosted `bolt-server`.                                  | The Host API.                                                                      |

## Package entries

| Entry                                 | Holds                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `@norbital-ai/bolt`                   | The declaration functions and their types.                                            |
| `@norbital-ai/bolt/errors`            | The canonical tagged errors shared by guest bodies, pages and tests.                  |
| `@norbital-ai/bolt/page`              | The Page SDK (`$bolt` in pages), the ui edge and Device.                              |
| `@norbital-ai/bolt/page/integrations` | An integration instance's browser client and setup view.                              |
| `@norbital-ai/bolt/engine`            | Native engine services, Layers and host ports.                                        |
| `@norbital-ai/bolt/artifact`          | A host's reader of built artifacts.                                                   |
| `@norbital-ai/bolt/protocol`          | Wire and artifact types and their Schemas; `/protocol/cursor` decodes page cursors.   |
| `@norbital-ai/bolt/host-api`          | The Host API between a host and a pinned release.                                     |
| `@norbital-ai/bolt/type-service`      | Hover, go-to-definition and draft checks over a workspace's tsconfig.                 |
| `@norbital-ai/bolt/docs`              | The API reference as data.                                                            |
| `@norbital-ai/bolt/isolate-globals`   | The guest's global surface beyond ECMAScript.                                         |
| `@norbital-ai/bolt/test`              | `TestWorkspace` and the Effect Vitest helpers; `/test/browser` mounts shell controls. |

## Authoring and pages

Import declarations from `@norbital-ai/bolt`. Transforms, queries, automation runs and
effectful sync bodies use `function*` and `yield* ctx.…`. Pure validators,
search callbacks and row mapping remain plain functions. Guest helpers
use `Effect.fnUntraced` or `Effect.fnUntracedEager`; Bolt owns the invocation runtime.

`ctx.ai.sys_2.infer` has no step budget unless the request sets `steps` (1–1000 model turns that
call tools, per batch of files), and no time limit: it goes on while it progresses (a model token, a reply, a tool
result), and five minutes without progress end it with the answer its draft already holds, else `timeout`. Once `steps`
is spent one final turn offers only the draft tools and must answer; without a valid answer there or in the draft the call fails `invalid`, naming the budget and what the draft still breaks.
In an automation run each tool turn is a durable step in the run's journal, with its AI, infer and HTTP answers: a run
resumed on another host goes on after its last step, and a run waiting over 30 s parks, holding no isolate.

`ctx.ai.embed` resolves each FileRef against the workspace's stored file record and sends its
metadata to the host. The provider reads the media through the host's scoped file facility after
forming each batch; image bytes stay outside the Cell. Hosts serving these releases use Host API 11.

A structured `output` is built on a draft (`initial`, else empty) with draft tools: `edit` (`{ ops: [{ path, set | remove: true | append }] }`,
each op applied and checked on its own), `read` (`{ path, fields? }`), `find` (`{ text, path? }`), `diff` (`{ path? }`:
changes since the start) and `submit`. Paths are JSON Pointers, except that an item of a keyed list
(`{ kind: 'list', of, key: 'code' }`) is addressed by its key (`/leave/ANNUAL/days`), so a removal never shifts another
item's path; keys are distinct and non-empty. Request `rules` (CEL over the output's top-level fields) must hold at
`submit` and when the budget is spent, so a review whose items start `pending` fails `invalid` unless the model finishes
it (`coverage.all(c, c.status != 'pending')`). `jsonDiff(before, after, output?)` from `@norbital-ai/bolt` is the same
pure comparison, for verifying changed rows and composing a change summary.

With `runAs` policies, `tools` may name `'read'` beside host tools: the model reads workspace
records as those policies (grants, field masks and row scopes as for `ctx.query`), one bounded
engine read per call (default 50 rows, at most 200; up to 8 batched), across as many turns as
`steps` allows. A `runAs: 'trigger'` run cannot offer it. The draft's reader is then named
`read_answer`.

```ts
// three-way match: the invoice against its open PO and goods receipts
const match =
	yield *
	ctx.ai.sys_2.infer({
		prompt: `Invoice ${inv.number} from supplier ${inv.supplier}: ${JSON.stringify(inv.lines)}.
Read open purchase_orders and goods_receipts for this supplier; match quantities and unit prices.`,
		output: {
			kind: 'object',
			fields: { matched: { kind: 'bool' }, variances: { kind: 'list', of: { kind: 'text' } } }
		},
		tools: ['read'],
		steps: 6
	});
```

Pages import the typed `bolt` from `$bolt`. `bolt.query(name, args)` returns a `Query<T>`:
reactive reads of `.current`, `.loading` or `.error` subscribe; awaiting it in an event handler reads
once; `yield*` composes it as an Effect. Identical reads share a subscription, released after its
last reactive reader leaves. `aggregate` and `history` use the same live/once contract. Capture
reactive inputs in `$derived`; use `bolt.clock('day' | 'minute' | 'hour')` for explicit time.
The generated module also exposes `run`, `fork` and `attach` for mutations and mounted resources.
An act succeeds with `committed` or `pendingApproval`; refusals, conflicts and unknown write
outcomes remain typed failures. See [the workspace contract](./workspace-contract.md) and
[APIs and execution](./apis.md).

Members-only pages use the workspace SPA; its opening cover remains until all emitted main-thread
modules initialize and stylesheets load. Public and external apps, and kiosks whose auth is not
`members`, render HTML on the server and hydrate only the requested page's browser graph. Each
needs a `+<page>.page.server.ts` read-only loader and shared `<page>.page.data.ts` codec. See
[Client bundles and public rendering](./client-bundling.md) for authoring, artifact and host boundaries.

## Teams

Teams exist only in source: `src/access_control/team/+team.ts` maps each handle to a policy list
or `{ name?, parent?, policies }`. No table holds them. A member's, invitation's or API key's
`team` is a text field with `format: 'team'` holding one declared handle; every write refuses an
undeclared handle, and a handle removed from source confers nothing. Authority, the `parent` graph
(`actor.teamTree`), approval flows (`supersededBy` and step teams are exact handles), team
previews and the People team picker all read the manifest. `{ actor: 'teams' | 'teamTree' }` is an
`in`/`nin` operand on `format: 'team'` fields.

## Record history and restore

Every committed write appends to `bolt_history`: one revision per record, with who, when, its
cause and the fields it changed. `bolt.history(c, id)` lists them; `bolt.query(c, { id, revision })` folds the record as of one. Pruning keeps the newest 256 revisions per record and
folds the rest into a full-row anchor, so every kept revision still rebuilds.

Three restores, never the same thing:

| Restore                | What it restores                                                                           | Where                                            |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Point-in-time recovery | The whole workspace database, to a moment. Every record, later writes included, goes back. | The host's database backups; an operator action. |
| Per-record restore     | One live record's own fields, to a past revision, as a new latest revision. History stays. | "Restore this version" in a record's History.    |
| Source rollback        | The workspace code, to a deployment commit. Data is untouched.                             | Studio's deployment history.                     |

Per-record restore is two own callables, `history.preview` and `history.restore`, each taking
`{ collection, record, revision }` (`bolt.restore.preview` / `bolt.restore.run` in pages). The
preview lists each field that would change (current and restored value) and each one left alone,
with its reason: a link whose target was deleted, read-only (integration-owned or the owned
parent's key), no grant, a locked state move, masked, or a definition that changed. Only the
record's own stored columns are restored; computed fields, roll-ups, `seq`, system columns, owned
children and many-relations are never touched, and a link's target is never written. The restore
is one ordinary `update` observed at the previewed revision, so a concurrent change is a conflict
and grants and approvals apply as to any edit. History records it with cause `restored` and the
source revision in `restored_from`; restoring an earlier revision undoes it. A deleted record
cannot be restored this way: History is shown on live records.

## Administrator audit trail

Settings → Audit queries a separate host-owned audit store. Administrators can search event
payloads and filter by time, actor, operation, status, model, record, invocation or run. Pages
contain bounded metadata summaries; opening an event loads its complete payload. Time and
event id determine stable cursor order. A missing audit backend is unavailable, rather than an
empty history.

The host binds tenant and environment scope; a query cannot choose another workspace.
`AuditPort` is a host facility, with immutable event ids, idempotent append and explicit
conflicts when the same id carries different data. Native publishers provide actor and operation
metadata. Workspace generators have no audit append facility. A committed or held status requires
the native database acknowledgement; prepared and unknown states make no such claim.

Audit payloads do not belong in the host's system/control database or in a new tenant model.
`bolt_history` remains in the tenant database because revision reads, approval rollback and
record restore require it. Native model triggers capture revisions and referential cascades;
application policy checks still belong to admitted Bolt writes. Runtime logs remain diagnostic
events with their own size, rate and retention limits; run journals remain temporary execution
state. These are separate contracts.

Hosts declare `durable`, `buffered` or `disabled` acknowledgement. A buffered host can lose
accepted events in a crash before its disk flush; append/read-back is not an fsync receipt.
Disabled hosts refuse audited writes.

For audited mutations, prepared intent is acknowledged before the tenant lease. The tenant
keeps a minimal operation receipt, not a bulk payload outbox. Recovery pages unresolved host
intents and reconstructs confirmed effects from that receipt and retained revision history.
History trimming and erasure retain every revision needed by an unacknowledged operation.
Trimming also retains open approval checkpoints. If a required checkpoint is unavailable,
rollback refuses the decision and leaves the request open.
An erase commits its domain change first; physical history erasure remains pending until the
complete external payload is acknowledged for every overlapping operation under the host's
declared persistence guarantee. Only operation ids,
record ids, revision bounds and field names are retained as deferred-purge metadata. The erase
is immediately applied to ordinary history/as-of/restore reads; only audit recovery can use
the physically retained images. The erase marker keeps a complete sanitised baseline for later
revision reads. Recovery also reconciles
external terminal events whose local acknowledgement was interrupted, then drains pending
history erasures in bounded native batches without host I/O under a database lock.
The databases do not share an atomic commit: a missing receipt remains unresolved. Do not infer
success from a prepared or unknown event or assume all event categories have publishers.

The dedicated host audit database is configured separately from the control database. Records
expire 30 days after the host records them, using `recorded_at` rather than the event's occurrence
time. Permanent tenant deletion retires its audit namespace and purges its records earlier.
Tenant erase sanitizes tenant history; previously appended external payloads remain until
retention expiry or permanent tenant deletion, so erase does not immediately remove all audit
copies. Unresolved recovery fences remain during an audit-store outage.

## Approvals

A write grant's pure `approval(write, flow)` callback returns a flow. `write` contains
`op`, `record`, `previous`, `changed` and `requester`, typed from the model. A direct grant from
another held policy executes directly; without any matching grant the write is refused.

```ts
create: {
  fields: ['job', 'title', 'amount'],
  approval: (write, flow) => flow
    .step('Controller review', { teams: ['controllers'] })
    .if(write.record.amount !== null && write.record.amount.gte(5000),
      (f) => f.step('Commercial sign-off', { teams: ['commercial'] }))
    .supersededBy(['controllers'])
}
```

`step(name, { teams?, users? })` appends one step; any listed approver may decide it.
`if`, `else`, `allow()` and `deny(message)` express conditional routing. Callbacks have no reads
or I/O. The flow is snapshotted when the request opens and evaluated again on resubmit; changed
steps restart at the first step. A new release does not rewrite an open request's saved flow.

A routed write commits provisionally with history and a checkpoint of every held record.
The shared approval panel shows the request and each named step as a timeline; its request
selector preserves all earlier requests. `bolt.approvals.decide(id, { decision, reason? })`
accepts `approve`, `reject` or `requestChanges`. Reject and request-changes require a reason;
approval may include one. A superseder uses Approve with a reason. Comments exist only as
decision reasons. A requester cannot withdraw a request.

| State             | Decision                                   | Result                                       |
| ----------------- | ------------------------------------------ | -------------------------------------------- |
| Pending           | approve                                    | next step, or approved after the last        |
| Pending           | reject                                     | rejected; restore the pre-request checkpoint |
| Pending           | requestChanges                             | keep data; requester may edit                |
| Changes requested | requester saves                            | resubmit the same request and log            |
| Open              | authorized superseder approves with reason | superseded; keep data                        |

Rejected, approved and superseded requests are terminal. Saving requested changes resubmits;
the record's Save button reads Resubmit. There is no separate resubmit operation in page code.
Rollback restores an updated record, deletes one created by the request, or re-creates a deleted
one from history. Fields whose targets or definitions disappeared are reported and skipped.
Derived roll-ups follow their rows and are never restored directly.

The approval lock is enforced in the commit statement on every write path, including bulk,
imports, syncs, nested owned children, cascades and restore. Pending records may be edited only
by current approvers; requested changes only by the requester. Administrators may supersede but
cannot bypass the lock. Outbound sync writes wait for approval.

Every held read row carries `$approval: { requestId, state, step, steps, requestedBy, waitingOn }`.
Shared Table and Board views show it automatically. The model's `notify(event, ctx)` callback
receives write and approval events and returns notices after commit; see [notifications](./notifications.md).

## Hosts and tests

`@norbital-ai/bolt/engine` exposes native service tags and Layers. `EngineLive(manifest)` composes
the engine areas over `TenantDb`, `Activation` and the host port services. `PgliteDb.layer(from?)`
owns its PGlite resource; `PostgresDb.layer(pool)` uses a pool owned by the host. `BoltHostLive`
composes the engine's request handlers with the shell/session services in a fixed route order.
These modules return Effects; the host owns execution and resource lifetime.

`EngineHost` includes `Crypto.Crypto` for secure UUID generation. At a Node entry, provide
`NodeCrypto.layer` or the complete `NodeServices.layer` from `@effect/platform-node`.
Engine and identity constructors capture this service for their returned operations.

Native guest execution uses `isolated-vm` 7 on Node 26. Start Node with
`--no-node-snapshot`, as required by [isolated-vm](https://github.com/laverdet/isolated-vm#requirements)
for Node 20 and later. The Bolt executable and fork test workers supply this
flag. A custom host or direct `node` invocation must supply it before loading the engine.

Native installs require Python 3, make and a C++ compiler. The repository's pinned isolated-vm 7.0.1
patch fixes module-code-cache consumption and builds the addon from source. Keep the pnpm workspace
policy, patch file and lockfile together when projecting a standalone template.

Guests initialize their prelude and evaluate tenant source in a fresh isolated heap. Builds produce
no native V8 snapshot, and artifact readers never open historical snapshot blobs. Historical
descriptor metadata remains covered by artifact integrity checks. `HOST_API.guestExecution`
declares `source`; hosts require that policy before admitting a runtime.

Fresh invocation preparation does not sample heap statistics. Only isolates retained in the warm
pool need that measurement for its memory cap. All preparation CPU remains charged.

Each program pool may retain a private module code cache produced from its exact source. Cache bytes
and prepared heaps share the warm-memory cap; disabling warm preparation also disables code caching.
Every invocation still evaluates a fresh module heap, and the first cache producer retains its actual
preparation CPU charge. Closing the pool disposes compiling isolates and waits for native settlement
before releasing borrowed cache handles. Borrowing a prepared isolate immediately refills its warm slot.

The compiler first bundles every declaration and evaluates it twice for the manifest and all build
checks. Only a clean check produces the runtime `guest.mjs`: a second native bundle exports the
runner's callback paths while omitting unused metadata from those exports. Every role module still
initializes in its original order, including modules imported only for their side effects. Callback
names, source maps, byte assets and declaration validation retain the same contracts. The runtime
output is compressed with Terser after native bundling, preserving function and class names and
chaining the original source map; property mangling and unsafe compression are disabled.

The guest loads canonical tagged-error families when an operation needs them. Failure-shaped act
outcomes still validate against the act schemas; facility and declared-read failures decode at their boundaries.
`@norbital-ai/bolt/errors` reexports those same constructors, preserving class identity for authored
error handling and the guest's refusal conversion.

A pinned release crosses a separate host module graph through `@norbital-ai/bolt/host-api`.
`HOST_API` retains Promise + AbortSignal + Schema JSON at that ABI boundary. Effect values stay
inside their own graph. Integration provider drivers use the same kind of single boundary adapter.

Runtime artifact decoding lives in `src/engine/artifact/read.ts`, separate from the compiler
that writes artifacts. `src/protocol/errors.ts` owns the shared failure class and code table;
native engine failures and browser protocol decoders use those same identities.

`@norbital-ai/bolt/test` exports `TestWorkspace`, `TestWorkspace.layer(options)`, and the Effect
Vitest helpers. Suites declare `@effect/vitest` directly and import their helpers from it.
Acquire `yield* TestWorkspace` in `it.effect`, then yield native `t.as(actor)`
calls. Use `Effect.flip` or `Effect.result` to assert failures. The layer closes its database,
host and provider resources. Use the browser test entry to mount actual controls and exercise
current interactions. Edge case tests cover core behavior with synthetic fixtures; automated
layout/markup/CSS/pixel assertions, surface sweeps, seeded legal/catalogue correctness matrices and
retired-API absence checks do not belong in these suites. Templates run standalone without a host;
hosts test their own behavior independently of template suites.

## CLI and publication

The CLI is declared with `effect/unstable/cli` in `src/cli/main.ts`. `bolt sync`, `check`, `build`, `test`,
`dev` and `start` operate on one workspace. From a template repository root, `bolt templates`
provides `check`, `lock`, `verify` and `publish`; publication creates immutable projection refs
and checks fast-forward ancestry. Repository scripts may delegate to those commands.

Package builds and publication validation use the maintained TypeScript entries
`scripts/build-package.ts` and `scripts/validate-package-publication.ts` at the OSS root. Public
package manifests share one exact release version. Run `pnpm publication:check` in that repository
before a coordinated immutable package release; consumers import public package subpaths.

## Documents

- [Schema and public type inference](./inference.md)
- [Workspace contract and file roles](./workspace-contract.md)
- [Models and write callbacks](./models.md)
- [APIs and execution](./apis.md)
- [Syncs: files and integrations](./syncs.md)
- [Search](./search.md)
- [Notifications](./notifications.md)
- [Documents](./documents.md)
- [Custom datatype renderers](./custom-fields.md)
- [Integration definitions, instances and providers](./integration-providers.md)
- [Identity automation events](./identity-automations.md)
- [Client bundles and public rendering](./client-bundling.md)
- [Device, device notices and app sessions](./device.md)
- [Changing the workspace with Norbius (ask, preview, approve)](./norbius-changes.md)
- [Self-hosted server (`@norbital-ai/bolt-server`)](../../bolt-server/README.md)
