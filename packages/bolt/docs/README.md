# Bolt

Bolt declares, compiles and runs a workspace. Authors write typed declarations and generator
bodies; the compiler produces one artifact, and a host activates that artifact in a scoped service
graph. The manifest defines the schema.

## Terms

Each word names one thing:

| Term        | Means                                                                                                                | Where                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Environment | An operating environment: local, staging or production, and a tenant environment inside one.                         | The operator CLI that resets and operates environments; never a workspace setting. |
| Secrets     | Encrypted values stored in the tenant database, read by server code.                                                 | `src/+secrets.ts` with `secrets({ NAME: { label } })`.                             |
| Server code | Transforms, queries, actions, automations, pipelines, integrations and page loaders.                                 | The `ctx` each receives; declarations from `@norbital-ai/bolt`.                    |
| Page SDK    | What browser-side page code calls.                                                                                   | `@norbital-ai/bolt/page`, imported in pages as `$bolt`.                            |
| Device      | What the shell running the page provides: location, notifications, push, background notices, opening external links. | `bolt.device` in pages; a shell installs `window.boltDevice`.                      |
| Shell       | The container a workspace runs in, which implements Device.                                                          | The web shell built into Bolt; native apps from `@norbital-ai/app-shell`.          |
| Host        | The server that runs workspaces: a hosting platform or a self-hosted `bolt-server`.                                  | The Host API.                                                                      |

## Package entries

| Entry                                 | Holds                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `@norbital-ai/bolt`                   | The declaration functions and their types.                                              |
| `@norbital-ai/bolt/errors`            | The canonical tagged errors shared by guest bodies, pages and tests.                    |
| `@norbital-ai/bolt/page`              | The Page SDK (`$bolt` in pages), the ui edge and Device.                                |
| `@norbital-ai/bolt/page/integrations` | An integration instance's browser client and setup view.                                |
| `@norbital-ai/bolt/engine`            | Native engine services, Layers and host ports.                                          |
| `@norbital-ai/bolt/artifact`          | A host's reader of built artifacts.                                                     |
| `@norbital-ai/bolt/protocol`          | Wire and artifact types and their Schemas; `/protocol/cursor` decodes page cursors.     |
| `@norbital-ai/bolt/host-api`          | The Host API between a host and a pinned release.                                       |
| `@norbital-ai/bolt/type-service`      | Hover, go-to-definition and draft checks over a workspace's tsconfig.                   |
| `@norbital-ai/bolt/docs`              | The API reference as data.                                                              |
| `@norbital-ai/bolt/isolate-globals`   | The guest's global surface beyond ECMAScript.                                           |
| `@norbital-ai/bolt/test`              | `TestWorkspace` and the Effect Vitest helpers; `/test/browser` mounts pages and sweeps. |

## Authoring and pages

Import declarations from `@norbital-ai/bolt`. Transforms, queries, actions, automation runs and
effectful integration/pipeline bodies use `function*` and `yield* ctx.…`. Pure validators,
similarity callbacks, row mapping and outbound builders remain plain functions. Guest helpers
use `Effect.fnUntraced` or `Effect.fnUntracedEager`; Bolt owns the invocation runtime.

`ctx.ai.sys_2.infer` has no step budget unless the request sets `steps` (1–1000 model turns that
call tools, per batch of files). Once spent — or after 24 of the batch's 30-minute ceiling, whichever
comes first — one final turn offers only `patch`/`submit` and must answer; without a valid answer there or in the draft the call fails `invalid`, naming the budget.

With `runAs` policies, `tools` may name `'read'` beside host tools: the model reads workspace
records as those policies (grants, field masks and row scopes as for `ctx.read`), one bounded
engine read per call (default 50 rows, at most 200; up to 8 batched), across as many turns as
`steps` allows. A `runAs: 'trigger'` run cannot offer it. With `initial`, the draft's pointer
reader is then named `read_answer`.

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

Pages use `$bolt`: `bolt` is the typed `PageBolt`, reads and acts are Effects, and `bolt.live(read)`
is a Stream. The generated module also exports `query`, `live`, `run`, `fork` and `attach` from
`@norbital-ai/ui/effect`. `query(() => effect)` and `live(() => stream)` share reactive query state,
typed errors and cancellation; their factories track reactive inputs. Use `{ initial: data }` for
loaded SSR data. See the UI package's [async reads](../../ui/docs/README.md#async-reads).
The shell mounts and disposes that edge. An act succeeds with a committed write, or one committed pending approval;
refusals, conflicts and unknown write outcomes are typed failures.

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
(`actor.teamTree`), approval routes (`superseded_by` and step teams are exact handles), team
previews and the People team picker all read the manifest. `{ actor: 'teams' | 'teamTree' }` is an
`in`/`nin` operand on `format: 'team'` fields.

## Record history and restore

Every committed write appends to `bolt_history`: one revision per record, with who, when, its
cause and the fields it changed. `bolt.history(c, id)` lists them; `bolt.get(c, id, undefined,
{ revision })` folds the record as of one. Pruning keeps the newest 256 revisions per record and
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

## Approvals

A grant's `approval` routes a write the caller has no direct grant for. The write **commits at once**
(a provisional commit, with history) and opens an approval request that holds it. The request keeps
its route snapshot, the checkpoint (the pre-request revision of the root and every inline or owned
child it touched), and a log of every interaction. The one transition table is
`src/engine/approvals/machine.ts`. The engine enforces it, and the approval view's buttons are its
answer for the viewer.

| From             | Move           | By                                                          | To                                      | Effect                               |
| ---------------- | -------------- | ----------------------------------------------------------- | --------------------------------------- | ------------------------------------ |
| Pending k/n      | approve        | step k's approvers                                          | Pending k+1, or Approved after the last | the change stands                    |
| Pending          | reject         | step's approvers                                            | Rejected                                | rollback to the checkpoint           |
| Pending          | requestChanges | step's approvers (reason required)                          | ChangesRequested                        | data stays; only the requester edits |
| Pending          | withdraw       | requester                                                   | Withdrawn                               | rollback                             |
| Pending          | supersede      | admin or `superseded_by` (reason)                           | Superseded                              | the change stands                    |
| ChangesRequested | resubmit       | requester (optional note)                                   | Pending 1/n (same request, same log)    | —                                    |
| ChangesRequested | reject         | that step's approvers                                       | Rejected                                | rollback                             |
| ChangesRequested | withdraw       | requester                                                   | Withdrawn                               | rollback                             |
| open             | comment        | requester, approvers, superseders                           | unchanged                               | a log entry                          |
| open             | close          | admin, only once a release removed the collection or record | Withdrawn (reason `source changed`)     | rollback of what still exists        |

Approved, Rejected, Withdrawn and Superseded are terminal. A finished request is never deleted,
reset or reused. Erasure is the only exception: it removes the requests that hold an erased record.
A record's approval history is all its requests in order. A new routed write is a new request.
Every other move is refused, with the reason.

**Rollback** (reject, withdraw, close) uses per-record restore in the decision's own statement,
recorded `restored` from the checkpoint revision:

- an updated record is restored;
- a record created by the request is deleted (`restored_from` 0);
- a record deleted by the request is re-created from its history.

Fields restore must skip are reported in the log entry and shown in the timeline; they never fail the
decision. Examples: a link to a since-deleted target, a definition that changed, a collection a
release removed. Derived fields (roll-ups, counts, sums) are never restored; they follow their rows.
Outbound sends from a held record wait until it is approved.

**The lock.** While a request is open, the records it holds, and any owned child created under them,
change only through it: by the current step's approvers in Pending, and by the requester in
ChangesRequested. Their edits join the request. Administrators supersede, but cannot edit around
the lock. The lock is a piece of the one commit statement, so it holds on every path: act, bulk,
import and upsert, actions and batches of any collection, automations, feeds, the agent, cascades
and set-null, and restore. It refuses the whole act with `locked` ("Under approval: <who> may change
it", `data.requestId`). A derived roll-up on a held parent is not an edit.

**Reads.** Every read row a request holds carries
`$approval: { requestId, state, step, steps, requestedBy, waitingOn }` (`step` counts from 0). Tables
and boards accent such rows with this tooltip; a custom list reads `row.$approval`. Approval
lifecycle events notify through the collection's `notifications` rules: `approvalStarted`,
`approvalStepRequested`, `approvalStepApproved`, `approvalCompleted`, `rejected`,
`approvalChangesRequested`, `approvalResubmitted`, `approvalWithdrawn`, `approvalSuperseded` and
`approvalCommented`. The provisional commit itself raises `committed`. A release that changes the
declaration keeps each open request's route snapshot. Decisions recheck current teams, and the lock
and `$approval` hold until the request finishes.

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
host and provider resources. The browser test entry supplies the happy-dom `sweep` Effect.

## CLI and publication

The CLI is declared with `effect/unstable/cli` in `src/cli/main.ts`. `bolt check`, `build`, `test`,
`dev` and `start` operate on one workspace. From a template repository root, `bolt templates`
provides `check`, `lock`, `verify` and `publish`; publication creates immutable projection refs
and checks fast-forward ancestry. Repository scripts may delegate to those commands.

Package builds and publication validation use the maintained TypeScript entries
`scripts/build-package.ts` and `scripts/validate-package-publication.ts` at the OSS root. Public
package manifests share one exact release version. Run `pnpm publication:check` in that repository
before a coordinated immutable package release; consumers import public package subpaths.

## Documents

- [Schema and public type inference](./inference.md)
- [Pipelines](./pipelines.md)
- [Integration definitions, instances and providers](./integration-providers.md)
- [Identity automation events](./identity-automations.md)
- [Client bundles and public rendering](./client-bundling.md)
- [Device, device notices and app sessions](./device.md)
- [Changing the workspace with Norbius (ask, preview, approve)](./norbius-changes.md)
- [Self-hosted server (`@norbital-ai/bolt-server`)](../../bolt-server/README.md)
