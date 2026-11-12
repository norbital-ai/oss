# Bolt

Start with the [behavior and mechanism map](./mechanisms.md). The website publishes every maintained guide in the [mechanism handbook](https://norbital.ai/docs/handbook), from the same pinned package as its generated API reference.

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
The generated proof stores shared native definitions once, compresses large function bodies, and expands each prefix before checking its hash;
this reduces artifact reads without changing the verified schema or migration ledger.

Review the operational hazards in each SQL step as well as its data acceptance. Adding a column or constraint takes
a table lock; an ordinary index build blocks writes and scans the table. Proven integer widening uses `ALTER TYPE`
to preserve stored values, but can rewrite the table and rebuild indexes under an exclusive lock. Hosts bound lock
waits and roll back a file if its lock cannot be acquired. `CONCURRENTLY` is refused because files run atomically.

Edit generated SQL for data patterns the planner cannot express; replay keeps the edited history equal to the
declared schema, and `bolt build` rewrites its lock and physical proof. Idempotency is per file: the ledger, the file
and its receipt commit in one transaction under the `bolt:schema` advisory lock, so a retry after any failure or a
concurrent applier runs nothing twice. Generated steps are not individually re-runnable; write hand data steps so a
second run is a no-op. Each file runs under the PostgreSQL adapter's `lock_timeout` 5 s and `statement_timeout` 15 s
(`DATABASE_SETTINGS`; PGlite's WASM backend cannot enforce them) and every adapter's 20 s call wall; a backfill beyond
that budget rolls back and must be reshaped.

A `-- check: <name>` line followed by one `SELECT` is a post-condition: the host runs it inside the file's transaction
and fails the file with SQLSTATE `BM005`, naming the check and its row count, when any row returns. A file holding a
check stays in a squash's retained suffix.

Run `bolt build --squash=release_name` to create a verified schema baseline for a complete prefix. Use lowercase
letters, digits and underscores in the name. Its receipt binds the exact original filenames,
checksums and replayed schema; the original SQL stays under `migrations/archive/` and the alternative baseline under
`migrations/squashes/`. Commit both directories and the updated lock. Studio's `preview` op takes `squash: <name>` and lands the same result in the working tree. Squashing
needs no environment to be current: archived originals finish any partially applied database. A fresh database runs the longest verified
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

| Term        | Means                                                                                                                      | Where                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Environment | An operating environment: local, staging or production, and a tenant environment inside one.                               | The operator CLI that resets and operates environments; never a workspace setting. |
| Secrets     | Encrypted values stored in the tenant database, read by server code.                                                       | `src/+secrets.ts` with `secrets({ NAME: { label } })`.                             |
| Server code | Transforms, policy verdicts, effects, automations, syncs and integrations.                                              | The `ctx` each receives; declarations from `@norbital-ai/bolt`.                    |
| Page SDK    | What browser-side page code calls.                                                                                         | `ctx` prop, typed by `@norbital-ai/bolt/page`.                            |
| Device      | What the shell running the page provides: location, notifications, push, background notices, opening external links.       | `ctx.device` in pages; a shell installs `window.bolt_device`.                      |
| Shell       | The container a workspace runs in, which implements Device.                                                                | The web shell built into Bolt; native apps from `@norbital-ai/app-shell`.          |
| Host        | The server that runs a bundle and supplies its facilities: Colony (tethered, the default) or an untethered host.           | `@norbital-ai/bolt/facilities`; the Host API. See [hosts](./hosts.md).             |
| Output      | A model's named read shape: a nested tree under `outputs`, including `default`. Every read selects one.      | `+model.ts` `outputs`; a read root's `output` option.                   |
| Policy      | What holders may do: the outputs they read and the rows of each, writes, state moves, capabilities, limits, manual starts. | `src/access_control/policy/`; held by teams, kiosks, envoys and automations.       |
| Automation  | A durable job or immediate call the system identity runs with its declared `policies`.             | `src/automation/+<name>.automation.ts`.                                            |
| Effect      | The work after a committed write. It runs as the writer and holds no policy.                                               | A model's `effect`.                                                                |
| Integration | What connects a workspace to an outside system: a source definition and its connections, each one account.                 | [Integrations, syncs and channels](./integrations.md) |
| Sync        | Rows exchanged between a model and a connection.                                                                           | A model's `syncs`; [syncs](./syncs.md) |
| Channel     | A connection whose driver carries conversations.                                                                           | [Integrations, syncs and channels](./integrations.md) |
| Envoy       | The agent answering outside senders on a channel.                                                                          | `sys_envoy`; bound by `sys_integration.envoy` |

## Package entries

| Entry                                 | Holds                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| `@norbital-ai/bolt`                   | The declaration functions and their types.                                            |
| `@norbital-ai/bolt/errors`            | The canonical tagged errors shared by guest bodies, pages and tests.                  |
| `@norbital-ai/bolt/page`              | Page context types, device helpers and the integration setup view.                    |
| `@norbital-ai/bolt/engine`            | Native engine services, Layers and host ports.                                        |
| `@norbital-ai/bolt/artifact`          | A host's reader of built artifacts.                                                   |
| `@norbital-ai/bolt/protocol`          | Wire and artifact types and schemas, including the page cursor decoder.   |
| `@norbital-ai/bolt/host-api`          | The Host API between a host and a pinned release.                                     |
| `@norbital-ai/bolt/docs`              | The API reference as data.                                                            |
| `@norbital-ai/bolt-cli/test`          | `TestWorkspace` and the Effect Vitest helpers.                                        |

## Authoring and pages

### Discovering a contract

The installed package's exported declarations are the API authority for that version. Start from its package
entries or the generated API reference, then use TypeScript completions on an imported namespace to discover its
exported values or types. Inspect the chosen symbol's hover documentation and call signature; follow its definition
when a nested option needs detail. This also works through re-exports and for UI component prop contracts.

In Studio, `workspace_lang` reads the workspace's locked dependencies and your working tree.
Its completions are paged; follow `next` or narrow by `prefix`. An edit commits nothing, so a probe file holding
a namespace import can explore an API, and `workspace_move` deletes it. A `type` query accepts TypeScript import types, for
example `typeof import('@norbital-ai/bolt').automation` or `import('@norbital-ai/bolt/page').PageBolt['act']`.
Invalid probes return compiler diagnostics; a type that is too large asks for a narrower query rather than pretending
a clipped answer is complete. Hover an actual member or query its value to read that member's documentation.

Workspace-specific model, page and automation names come from the latest generated registry. Run `bolt check` (in
Studio, a diagnosis) after adding or renaming declarations before relying on those names. A resolved type proves the expression is valid
in that program; it does not prove runtime permission, validation, provider availability or business behavior. Use
`bolt check` and `bolt test` (in Studio, a diagnosis and a test) for those separate obligations.

Public API documentation belongs on the owning exported declaration, so the LSP and generated reference read the
same source. Explain the operation, authority and lifecycle, required options and defaults, result and failure behavior,
and any important distinction from a related contract. Use `@param`, `@returns`, `@example` and `@see` where they help;
examples should show the supported path and retain types. A private design-rule number alone is not API guidance.
Keep examples next to their contract and cover important examples with compiler or runtime tests when behavior changes.

### Server and page execution

Import declarations from `@norbital-ai/bolt`. Transforms, policy checks, automation runs and
effectful sync bodies use `function*` and `yield* ctx.…`. Pure validators,
search callbacks and row mapping remain plain functions. Guest helpers
use `Effect.fnUntraced` or `Effect.fnUntracedEager`; Bolt owns the invocation runtime.

`ctx.ai.sys_2.infer` has no step budget unless the request sets `steps` (1–1000 model turns that
call tools, per batch of files), and no time limit: it goes on while it progresses (a model token, a reply, a tool
result), and five minutes without progress end it with the answer its draft already holds, else `timeout`. Once `steps`
is spent one final turn offers only the draft tools and must answer; without a valid answer there or in the draft the call fails `invalid`, naming the budget and what the draft still breaks.
An inference reruns with the run that called it: a run the process drops goes back to `queued` and reruns from the
start (up to 3 times), asking its AI, infer and HTTP calls again. Only chat sessions resume, from their saved turns.

`ctx.ai.embed` resolves each FileRef against the workspace's stored file record and sends its
metadata to the host. The provider reads the media through the host's scoped file facility after
forming each batch; image bytes stay outside the Cell. Hosts serving these releases use Host API 17.

A structured `output` is built on a draft (`initial`, else empty) with draft tools: `edit` (`{ ops: [{ path, set | remove: true | append }] }`,
each op applied and checked on its own), `read` (`{ path, fields? }`), `find` (`{ text, path? }`), `diff` (`{ path? }`:
changes since the start) and `submit`. Paths are JSON Pointers, except that an item of a keyed list
(`{ kind: 'object', fields, many: true, key: 'code' }`) is addressed by its key (`/leave/ANNUAL/days`), so a removal never shifts another
item's path; keys are distinct and non-empty. Request `rules` (CEL over the output's top-level fields) must hold at
`submit` and when the budget is spent, so a review whose items start `pending` fails `invalid` unless the model finishes
it (`coverage.all(c, c.status != 'pending')`).

In an automation, `tools` may name `'read'` beside host tools: the model reads workspace records
as the run's policies (granted outputs and row scopes as for `ctx.query`), one read request per
call: a layer map whose keys are the caller's roots and the layers of the output each names (unknown
keys refused; the same options, defaults and pages as `ctx.query`), across as many turns as `steps` allows. The draft's reader is then named
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
			fields: { matched: { kind: 'bool' }, variances: { kind: 'text', many: true } }
		},
		tools: ['read'],
		steps: 6
	});
```

Pages receive the typed `ctx` as a prop. `ctx.query(request)` takes a read request (a layer
map) and returns a `Query<T>`:
reactive reads of `.current`, `.loading` or `.error` subscribe; awaiting it in an event handler reads
once; `yield*` composes it as an Effect. Identical reads share a subscription, released after its
last reactive reader leaves. `aggregate` and `history` use the same live/once contract. Capture
reactive inputs in `$derived`; use `ctx.clock('day' | 'minute' | 'hour')` for explicit time.
The generated module also exposes `run`, `fork` and `attach` for mutations and mounted resources.
An act succeeds with `committed` or `pending_approval`; refusals, conflicts and unknown write
outcomes remain typed failures. See [the workspace contract](./workspace-contract.md) and
[APIs and execution](./apis.md).

Members-only pages use the workspace SPA; its opening cover remains until all emitted main-thread
modules initialize and stylesheets load. Public, external and shared apps render HTML on the server and hydrate only the requested page's browser graph. Both use
`ctx.query` for the initial rows and live browser updates. See
[Client bundles and public rendering](./client-bundling.md) for authoring, artifact and host boundaries.

Set `shell: 'kiosk'` on an app to serve its pages at `/kiosk/<app>/<page>` under fixed policies.
A public kiosk uses `audience.public`. A signed-in kiosk uses `policies` as the caller's entire
authority on its pages. External members can open kiosks that admit them. Staff open kiosks through
`capabilities.apps`, and administrators may open them directly. The build checks the named policies
and refuses capabilities on a kiosk policy for the `external` audience.

Opening a public app, including a public kiosk, mints a visitor when needed. The visitor is a
`sys_user` of kind `anonymous` (no address, never a member, absent from People) and a 30-day sliding
session whose token the visitor cookie holds. It is the visitor's `requestor.id`: a `sys_user` ref
defaulting to `{ var: 'requestor.id' }` makes it own what it creates, and a read `where` on that ref
lets it (alone) read them back. Its limits count per IP, as every visitor's do; minting is limited per IP
(`register`), and past that ceiling the page opens with no identity (a per-request id that owns nothing).
Signing in or up with that cookie links it: a newcomer's account _is_ the anonymous user (same id, rows
included); an existing account absorbs it — every workspace `sys_user` ref holding the anonymous id
moves to the account unless the row's state locks that field, and the anonymous user is deactivated.
Text copies of the id and `created_by` keep the anonymous id. The daily `bolt.prune` deletes anonymous
users with no live session (30 days unused, or retired by a link) that no record references.

A member who joined through `signup` is linked to the `signup.party` record that holds the number or email
they proved, and the link lasts only while it does. Their authority rechecks it on every request: when a
record's number changes or the record goes, the old holder sees nothing from their next request and the new
holder takes it. So the record's address is authority: a mistyped number hands that record to whoever holds
it. A party a person named on an invitation is never rechecked.

A stranger's code is a paid text. Sign-up texts are capped at 50 an hour for the workspace and 10 for one
address, and `signup.challenge: 'turnstile'` also asks a public page's bot check before a stranger is texted.
Members sign in without it. The check runs on public apps and kiosks; the workspace's own sign-in page has no
widget, so it stops offering sign-up. A host with no check configured refuses strangers, except a local one.

A field with `format: 'phone'` stores an international number in one spelling (`+6592000002`), whatever was
typed, so `unique` and the digit match see the same value. Rows written before this keep their spelling.

## Teams

Teams exist only in source: `src/access_control/team/+team.ts` maps each handle to
`{ policies, name?, parent? }`. A member's, invitation's or API key's
`team` is a text field with `format: 'team'` holding one declared handle; every write refuses an
undeclared handle, and a handle removed from source confers nothing. Authority, the `parent` graph
(`requestor.team_tree`), approval flows (`superseded_by` and step teams are exact handles), team
previews and the People team picker all read the manifest. `{ var: 'requestor.teams' }` and
`{ var: 'requestor.team_tree' }` are `in` operands on `format: 'team'` fields; exclude with a nested `not` predicate.

A filter value is a literal, `{ field: '<column>' }`, or `{ var: '<CEL>' }` (`@norbital-ai/std/vars`): a
typed expression over `requestor` and the clock, checked against the field's kind at decode and evaluated once
per read. Requestor expressions bind server-side; time expressions (`{ var: 'today - days(7)' }`,
`{ var: 'start_of_month(today)' }`, `{ var: 'now - hours(1)' }`) are evaluated at the edge and refused by the
store.

## Rate limits

A policy's `limits` throttle requests per holder (rule 38): `act` (every `/act`), `read` (`/q`, live
registrations and public page loaders, members per actor and visitors per IP), `upload`, `convert`,
`agent` (agent posts and filter descriptions), visitor `register` (minting an anonymous user), and envoy
`receive`/`unrecognised`. A visitor's limits count per IP, anonymous user or not.
Undeclared keys take defaults (members: `act 600/min`, `read 3000/min`, `upload 120/min`, `convert 30/min`,
`agent 100/h`; visitors, all per IP: `act 120/h`, `read 600/min`, `upload 20/h`,
`register 20/h`). Windows are fixed and
counted in the serving cell's memory; acts also persist theirs in their statement (`bolt_rate`), and a
cell taking a tenant reloads the open ones. Every refusal is `429` with `Retry-After` (seconds until the
window resets) and `{ code: 'rate_limited' }`, whose one message the shell translates.

Automations are limited only when started manually (`ctx.run`, Run now, the agent): each
counts against the quota of 30 starts per automation and starter per minute. Cron and model effect runs, and the acts any run's body performs, are never rate
limited; run budgets bound them.

## Record history and restore

Every committed write appends to `bolt_history`: one revision per record, with who, when, its
cause and the fields it changed. `ctx.history(c, id)` lists them; `ctx.history(c, id, { at: { revision } })` lists through that revision, and a root's `as_of` reads the record as it stood at an instant. Pruning keeps the newest 256 revisions per record and
folds the rest into a full-row anchor, so every kept revision still rebuilds.

Schema migrations register immutable definitions in `bolt_history_schema`, with an active pointer in
`bolt_history_current`. Revisions reference their definition in `meta.schema`. Model and field `was`
hints preserve their identities through renames; removing and later reintroducing a field creates a
new identity. Original revision payloads retain their old field names. The first update under a new
definition records a full post-image, so migrated values cannot inherit a stale value from the prior schema.

Built-in record history loads the selected revision's original field definitions and values,
its compatible projection into the current schema, and `incompatible` field names. It displays
that revision's original labels and kinds. Removed fields, invalid
values and unsupported conversions have an **incompatible** indicator; compatible scalar conversions
and declared renames restore automatically. Reference retargeting and changed custom field identities
require manual resolution. Current outputs, the record's current read scope and field visibility still apply. A
reader who loses access to the row loses its history. A
revision with no incompatible field is valid and projects into the record's own representation; an
invalid one shows only its captured data. `ctx.history(c, id)` marks each revision `valid` for its
timeline. Removed fields are visible only to administrators reading the default all-fields output.

Every retained revision requires its registered schema version and field identities. Missing versions
or identities are refused; runtime code never infers them from today's schema. Metadata
registration is a data step: preserve sequential migration files rather than squashing it into DDL.
Schema changes wait for affected open approvals and pending erasures to settle.

Three restores, never the same thing:

| Restore                | What it restores                                                                           | Where                                            |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| Point-in-time recovery | The whole workspace database, to a moment. Every record, later writes included, goes back. | The host's database backups; an operator action. |
| Per-record restore     | One live record's own fields, to a past revision, as a new latest revision. History stays. | "Restore this version" in a record's History.    |
| Live rollback          | Live's source and data together, to a Version. A differing schema discards newer data.     | Roll back live in Studio's timeline.             |

Per-record restore is two own callables, `history.preview` and `history.restore`, each taking
`{ model, record, revision }` (`bolt.restore.preview` / `bolt.restore.run` in pages). The
preview lists each field that would change (current and restored value) and each one left alone,
with its reason: a link whose target was deleted, read-only (integration-owned or the owned
parent's key), no grant, a locked state move, or an incompatible historical value. Only the
record's own stored columns are restored; computed fields, roll-ups, `seq`, system columns, owned
children and many-relations are never touched, and a link's target is never written. The restore
is one ordinary `update` observed at the previewed revision, so a concurrent change is a conflict
and grants and approvals apply as to any edit. History records it with cause `restored` and the
source revision in `restored_from`; restoring an earlier revision undoes it. A deleted record
cannot be restored this way: History is shown on live records.

## Administrator audit trail

The command center's Audit (`/command-center/audit`) queries a separate host-owned audit store. Administrators can search event
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
record restore require it. An act's one statement writes the revisions of its rows and of the
cascades it implies, and its audit receipt; the native model trigger captures raw SQL changes only.
Application policy checks still belong to admitted Bolt writes. Runtime logs remain diagnostic
events with their own size, rate and retention limits. These are separate contracts.

Hosts declare `durable`, `buffered` or `disabled` acknowledgement. A buffered host can lose
accepted events in a crash before its disk flush; append/read-back is not an fsync receipt.
Disabled hosts refuse audited writes.

For audited mutations, prepared intent is acknowledged before the tenant lease. The tenant
keeps a minimal operation receipt, not a bulk payload outbox. An act's commit statement carries
its receipt and answers its own row images, so its terminal event needs no read; its local
acknowledgement rides on the next commit statement (an erasure's follows at once), and recovery
acknowledges any a stopped process left. Recovery pages unresolved host
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

A policy grants each model's default and named `outputs`. The model fixes each output's shape.
Use `{}` for every row or `{ where, relation: { where } }` for nested scopes. The root
`where` scopes roots and may follow relations. A child scope filters its related rows or nulls a
ref. The granting policies' scopes union for that output.

Set `history: true` on an output grant to allow its revisions under that grant's root scope.
Another policy's broader current-row scope adds current rows while the history grant keeps its
scope. Every member
reads `sys_user`'s `directory` output (id, name): staff read staff, externals themselves and their
party; a read of `sys_user` without a `default` grant names `output: 'directory'`. `sys_file` declares
`default` (name, type, size, digest, field, uploader) and `meta` (id, name, mime) for a holder that only
lists files. A `create` or `update`
grant is `{ columns?: { fields: [...], '<relation>': { fields: [...] } }, verdict? }`; `{}` admits
every declared column. Columns are always this tree, as outputs are: `fields`, then one key per
relation. An update grant also lists allowed state edges in `moves`. A delete grant is
`{ verdict? }`. Columns are checked before the verdict judges the batch, including nested rows.
Return `ctx.allow()`, `ctx.approve({ steps, superseded_by })` or
`yield* ctx.refuse(message_key, { row?, field? })`, where `message_key` is a catalogue key and
`field` a root column. Among the holder's policies any allow
executes. Otherwise the first approval in team-policy order holds the batch for review, or the
first refusal supplies the failure
(`code: 'refused'`, `rule: '<policy>.<model>.<op>'`, with its `row` and `field`). A grant
guards its root's whole tree: a layer is never judged by its own model's policy.

```ts
create: {
  columns: { fields: ['job', 'title', 'amount'] },
  verdict: function* (changes, ctx) {
    const big = changes.some((c) => c.after.amount.gte('5000'));
    return ctx.approve({
      steps: [
        { name: 'Controller review', teams: ['controllers'] },
        ...(big ? [{ name: 'Commercial sign-off', teams: ['commercial'] }] : [])
      ],
      superseded_by: ['controllers']
    });
  }
}
```

A verdict reads with `ctx.query(read_request)` as the workspace, at most 10 crossings per call, and does
no I/O or writes. Each change carries `before`, `set`, `after` and `changed(...)`. A create has
null `before`; a delete has null `after`. The stored trees include the verb's declared layers.

`steps` lists named team-review steps. Use ordinary conditions to select steps and immediate
verdicts. The flow is snapshotted when the request opens and evaluated again on resubmit. Changed
steps restart at the first step. A new release does not rewrite an open request's saved flow.

A routed write commits provisionally with history and a checkpoint of every held record.
The shared approval panel shows the request and each named step as a timeline; its request
selector preserves all earlier requests. `ctx.approvals.decide(id, { decision, reason? })`
accepts `approve`, `reject`, `request_changes` or `withdraw`. Reject and request-changes require a
reason; approval and withdrawal may include one. A superseder uses Approve with a reason. Comments
exist only as decision reasons. Only the requester withdraws, while the request is open: the member
who asked, or any run of the automation that did (`ctx.approvals.withdraw(request_id, reason?)`).
An approver who is not the requester rejects instead.

| State             | Decision                                   | Result                                        |
| ----------------- | ------------------------------------------ | --------------------------------------------- |
| Pending           | approve                                    | next step, or approved after the last         |
| Pending           | reject                                     | rejected; restore the pre-request checkpoint  |
| Pending           | request_changes                            | keep data; requester may edit                 |
| Changes requested | requester saves                            | resubmit the same request and log             |
| Open              | requester withdraws                        | withdrawn; restore the pre-request checkpoint |
| Open              | authorized superseder approves with reason | superseded; keep data                         |

Rejected, approved, superseded and withdrawn requests are terminal. Saving requested changes resubmits;
the record's Save button reads Resubmit. There is no separate resubmit operation in page code.
Rollback restores an updated record, deletes one created by the request, or re-creates a deleted
one from history. Fields whose targets or definitions disappeared are reported and skipped.
Derived roll-ups follow their rows and are never restored directly.

The approval lock is enforced in the commit statement on every write path, including bulk,
imports, syncs, nested owned children, cascades and restore. Pending records may be edited only
by current approvers; requested changes only by the requester. Administrators may supersede but
cannot bypass the lock. Outbound sync writes wait for approval.

Every held read row carries `$approval: { request_id, state, step, steps, requested_by }`.
Shared Table and Board views show it automatically. Per-verb effects receive write changes or
approval events through `ctx.event` and call `ctx.notify` for custom notices; see [notifications](./notifications.md).

## Hosts and tests

Sign-in codes are issued only for active workspace members, unexpired open invitations, or newcomers
allowed by the workspace's open `signup`. An ineligible address returns `not_member` before a challenge
is stored or a code is sent, so the sign-in form stays on the address step.

`@norbital-ai/bolt/engine` exposes the port service tags and contracts a host fills; a host activates a
release through HostApi (`@norbital-ai/bolt/host-api`). The test kit's whole host (the engine over
`TenantDb`, its activation and the port services, then the shell/session routes in their fixed order) is
one scoped Layer, `test_engine` in `@norbital-ai/bolt/tooling`. `PgliteDb.layer(from?)` owns its PGlite
resource; `PostgresDb.layer(pool)` uses a pool owned by the host. These modules return Effects; the host
owns execution and resource lifetime.

The engine's host requirements include `Crypto.Crypto` for secure UUID generation. At a Node entry, provide
`NodeCrypto.layer` or the complete `NodeServices.layer` from `@effect/platform-node`.
Engine and identity constructors capture this service for their returned operations.

Bolt carries no guest runner, and the runner is no facility: each host owns its own and hands it to
the engine as `HostPorts.guests` (`GuestIsolatesPort`). bolt-cli's `node_guests`
(`@norbital-ai/bolt-cli/guests`) runs Node vm contexts in the host's own process: each call runs under
a timeout of what is left of the session's CPU budget, and the thread's CPU around it is metered. A vm
context shares the host's heap and is not a security boundary, so it caps no guest memory and runs
operator-trusted code only; bolt-server and `bolt dev` serve on it, and the test kit runs on it
internally. A multi-tenant kernel brings its own native isolates (Colony uses isolated-vm). `bolt check` runs no guest: it evaluates
the declarations twice, each on a worker thread stripped to a guest's ECMAScript globals.

Guests initialize their prelude and evaluate tenant source in a fresh context. Builds produce
no native V8 snapshot, and artifact readers never open historical snapshot blobs. Historical
descriptor metadata remains covered by artifact integrity checks. `HOST_API.guest_execution`
declares `source`; hosts require that policy before admitting a runtime.

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
(bolt-cli) that writes artifacts. `src/protocol/errors.ts` owns the shared failure class and code table;
native engine failures and browser protocol decoders use those same identities.

`@norbital-ai/bolt-cli/test` exports `TestWorkspace`, `TestWorkspace.layer(options)`, and the Effect
Vitest helpers; guest code runs on the kit's own `node:vm` runner. Suites declare `@effect/vitest` directly and import their helpers from it.
Acquire `yield* TestWorkspace` in `it.effect`, then `const caller = yield* t.as(actor)` and yield its
native calls; `t.as`, `t.visitor` and `t.body_acts` are Effects that fail with `BoltError`. Use `Effect.flip` or `Effect.result` to assert failures. The layer closes its database,
host and provider resources. With a `root`, the layer seeds from the template's `test` pack
(`seed/test/`, built once per source hash; `bolt build` also writes it to `.norbital/seed/test`, and no
host provisions it). It never loads the public `base` pack or bank rows; `seed: 'none'` or
inline rows replace the test pack. Use the browser test entry to mount actual controls and exercise
current interactions. The realm browser project uses Vitest's Playwright provider with one headless
Chromium browser shared by its test files. Agent web browsing continues to use the separate Obscura
fleet. Tests do not connect to that fleet or change its network policy.
Edge case tests cover core behavior with synthetic fixtures; automated
layout/markup/CSS/pixel assertions, surface sweeps, seeded legal/catalogue correctness matrices and
retired-API absence checks do not belong in these suites. Templates run standalone without a host;
hosts test their own behavior independently of template suites.

### Workspace URLs

Every host serves the same workspace-relative paths: an untethered host (bolt-server, `bolt dev --host`) at its
root, a tethered one under the base its `public_url` names (`/<label>` on Colony, whose own paths stay under
`/__colony`).

| Path                                                                                                                                    | Serves                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/`                                                                                                                                     | The shell home.                                                                                                   |
| `/sign-in[?next=<path>]`                                                                                                                | The one sign-in page.                                                                                             |
| `/inbox`, `/settings/<tab>`, `/command-center[/<tab>]`, `/studio[/<tab>]`, `/app/<app>/<page>`, `/kiosk/<kiosk>/<page>`, `/invite/<id>` | Shell routes (`shell/nav.ts` `route`).                                                                            |
| `/__bolt/*`                                                                                                                             | The wire (`protocol/wire.ts` `PATHS`), `/__bolt/shell/*`, `/__bolt/integrations[/<instance>/…]`, `/__bolt/sw.js`. |
| `/hooks/integration/<instance>`, `/hooks/oauth/callback`                                                                                | Integration ingress.                                                                                              |
| `/manifest.webmanifest`, `/assets/*`, the client build's files                                                                          | The PWA manifest and client bytes.                                                                                |

Each has one spelling, `canonical_path` (`protocol/wire.ts`): a repeated or trailing slash is answered with one 308
to it, query kept; the root keeps its `/`. The shell handler answers it first, so every host that routes through
`workspace.handle` answers it alike.

## CLI and publication

The CLI is `@norbital-ai/bolt-cli` (a workspace devDependency that never enters a release), declared
with `effect/cli` in its `src/cli/main.ts` beside the compiler and the test kit. `bolt sync`, `check`,
`build`, `test` and `dev` operate on one workspace ([the dev loop](./dev-loop.md)). From a template repository root,
`bolt templates` provides `check`, `lock`, `test`, `verify` and `publish`; `publish --out=<dir>` packs
each built template's release, by digest, for CI's R2 upload ([releases](./releases.md)). Repository
scripts may delegate to those commands.

Package builds and publication validation use the maintained TypeScript entries
`scripts/build-package.ts` and `scripts/validate-package-publication.ts` at the OSS root. Public
package manifests share one exact release version. Run `pnpm publication:check` in that repository
before a coordinated immutable package release; consumers import public package subpaths.

## Documents

- [The template dev loop](./dev-loop.md)
- [Releases](./releases.md)
- [Seeding](./seeding.md)
- [Host facilities](./hosts.md)
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
- [Example untethered host (`@norbital-ai/bolt-server`)](../../bolt-server/README.md)
