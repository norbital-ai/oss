# Current examples

These are places to inspect, not frozen code snippets. Check the current source before copying
API names or fixture shapes; a reference must not preserve a retired runtime contract.

## Native workspace success and refusal

For a fixture workspace whose `orders` model allows an administrator to create records,
the scoped kit drives the real host routes. A denied create fails with `ActRefused` and leaves
the row count unchanged:

```ts
import { Effect } from 'effect';
import { TestWorkspace, expect, layer } from '@norbital-ai/bolt-cli/test';

layer(TestWorkspace.layer({ root, seed: 'none' }))('orders', (it) => {
	it.effect('commits an admitted create and preserves rows after denial', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const admin = t.as(t.admin);
			expect((yield* admin.act('orders.create', [{ notes: 'Allowed' }])).kind).toBe('committed');
			const before = yield* admin.query({ orders: {} });
			const failure = yield* Effect.flip(
				t.as(t.member([])).act('orders.create', [{ notes: 'Denied' }])
			);
			expect(failure).toMatchObject({ _tag: 'ActRefused', code: 'forbidden' });
			expect((yield* admin.query({ orders: {} })).orders.rows).toEqual(before.orders.rows);
		})
	);
});
```

Replace the model and fields with the owning workspace's declared contract. Removing the
grant check must fail the refusal assertion; writing before denial must fail the persisted-row
assertion. `TestWorkspace.layer` owns the database and host scope, including cleanup on failure.

## The test seed pack

A template's tests seed from `seed/test/`, authored like `seed/`: `<model>.json[.gz]` (basename = model, any
subdirectory), identity rows as `sys_user.json`, optional `assets.json` + `assets/**`. No seeder, no bank.
`bolt check` decodes it; `bolt build` writes it to `.norbital/seed/test` with its own digest; no host provisions it.
The kit builds it once per source hash and loads it into every `TestWorkspace.layer({ root })` (it does not
layer on `base`; a row a test needs is in `seed/test/`).

```text
seed/test/
├── sys_user.json      [{ "id": "u-admin", "name": "Ada Admin", "email": "ada@example.test", "kind": "staff", "admin": true }]
└── orders.json        [{ "id": "o-1", "notes": "Open order", "status": "open" },
                        { "id": "o-2", "notes": "Closed order", "status": "closed" }]
```

```ts
layer(TestWorkspace.layer({ root }))('orders seed', (it) => {
	it.effect('refuses edits to a closed order', () =>
		Effect.gen(function* () {
			const t = yield* TestWorkspace;
			const failure = yield* Effect.flip(
				t.as(t.admin).act('orders.update', [{ id: 'o-2', notes: 'Changed' }])
			);
			expect(failure).toMatchObject({ _tag: 'ActRefused' });
		})
	);
});
```

Keep it to the few rows the mechanisms need: two states, one boundary, one refusal. Catalogue data the
product ships belongs in `base`; a test that needs a catalogue row writes its own synthetic one here.

## Inline business configuration and source access control

`templates/hr-payroll/tests/e2e/source-team-values.test.ts` drives the real authored engine. It
checks that suspension kinds live on their version, validates duplicate/empty codes, clones values
into a successor and refuses sealed edits. It also resolves source-team grants and approval eligibility while refusing writes to the
generated team catalogue. Team definitions, policy links and inline approvals are source;
member affiliation is runtime identity data.

The useful distinction is between a pure shape check and the write-path proof: a parser can
recognize valid values while the model forgets to invoke it. Use both only where they cover
different defects. The persisted version and refusal assertions carry the behaviour.

## Record capabilities and disclosure

`oss/packages/bolt/tests/record-capabilities.integration.test.ts` uses PGlite and native reads/grants.
It checks readable fields, granted outputs, layers under the root's policy and scope changes during capability reads.
A UI implementation guessing from an update contract would not satisfy those assertions.

Shared UI tests in the ui package should similarly exercise admitted/readonly fields, draft edits,
cancel, conflict and save outcomes. Alignment, overlap and narrow layout are probes, never tests.

## Authorization before credentials

`oss/packages/bolt/tests/integration-links.integration.test.ts` keeps the links manager, the
instance verbs and the engine real, with an injected provider. "authorize as \"may update this
row\"…" pairs the owner's and an administrator's success with an unsigned caller, another member,
an external member and a cross-site request, and asserts nothing was sealed after each denial. A
refusal-only suite would also accept a handler that refuses everyone. The same file proves fenced
credential writes (a second opener stops the first as `replaced`) and that an emit resolves only
after the engine committed its rows.

The sealed-credential assertion is meaningful because ordering is the requirement. Provider-open
counts alone would not prove that sync rows were written; that needs a state assertion.

## Integrations, syncs and envoys

`sync.integration.test.ts`, `sync-health.integration.test.ts`,
`file-sync-authority.integration.test.ts`, `conversations.integration.test.ts` and
`hotline.integration.test.ts` under `oss/packages/bolt/tests/` exercise current sync, caller-scope,
conversation and instance-isolation paths. Keep cursor/row atomicity, outbox retry and idempotency,
approval-held delivery and version-conflict rollback assertions on the native engine. Templates
do not re-test envoy admission or conversation transport; Bolt owns those mechanisms.

A template test reaches the same paths through the kit, stubbing only the link:

- Named instances are the manifest's `connections`; seed unnamed runtime ones as `sys_integration` rows
  (`id, integration, name, owner?, active?, configuration?`) or create them with
  `sys_integration.create`.
- Conversation inbound: `yield* t.receive('<slot>', message)` ingests the message and waits for
  queued sync reads and envoy turns. Use native conversation tests for delivery-report transport.
- Remote reads: `yield* t.syncs.read('<model>.sync.<sync>', { instance: '<slot>' })` drives the
  real remote sync. Set `t.fakes.links.answer` for `ctx.request`, or `t.fakes.links.page` for a
  pushing driver's `items`. Assert persisted rows, cursor/version handling and a repeated read.
- Queued writes: `yield* t.syncs.deliver()` drains the real outbox. Sends through a link appear in
  `t.fakes.links.sent` (`instance`, `message`); request writes use `t.fakes.links.answer`. Read the
  source row's `$sync['<sync>']` status and the acknowledged remote state, including refusal/retry.
- File syncs use the same caller as automations: `t.as(member).start('<model>.sync.<sync>', input)`.
  Upload with that caller's `upload('<model>.$import.<sync>', file)`, narrow its committed outcome,
  then pass `{ mode: 'import', file: uploaded.output.id, context? }`. Export with
  `{ mode: 'export', format: 'csv', context?, where? }`, or request `{ mode: 'template', format: 'csv' }`.
  The start returns a run receipt; `yield* t.runDue()` executes it. Schema-decode its `sys_run`
  output and assert stored rows, findings and exported file bytes. `syncs.read` is for remote
  reads; file syncs need no new kit method. Test caller scope, callback refusal, atomicity and retry.

Assert stored rows and the record's state, not only that a fake was called.

Read a started run through the existing native database. `Sql` is the plain typed
`{ text, params }` value; it is not a template tag and needs no value import:

```ts
const Run = Schema.Struct({
	state: Schema.String,
	output: Schema.NullOr(Schema.Json),
	error: Schema.NullOr(Schema.Json)
});
const [run] =
	yield *
	t.db.rows(Run, {
		text: 'SELECT state, output, error FROM sys_run WHERE id = $1',
		params: [started.output.id]
	});
assert.ok(run, 'The started run was recorded');
assert.equal(run.state, 'succeeded', JSON.stringify(run.error));
```

Here `started` is the narrowed committed start receipt after `yield* t.runDue()`.
Decode `run.output` with its actual output schema. For a file sync, resolve that
run's exact file before checking its bytes:

```ts
const Exported = Schema.Struct({
	file: Schema.Struct({ id: Schema.String, name: Schema.String, mime: Schema.String })
});
const { file } = yield * Schema.decodeUnknownEffect(Exported)(run.output);
const key =
	yield *
	t.db.value(Schema.String, {
		text: 'SELECT key FROM sys_file WHERE id = $1',
		params: [file.id]
	});
assert.ok(key, 'The output file has a storage key');
const bytes = t.fakes.files.blobs.get(key);
assert.ok(bytes, 'The run output names a stored file');
const csv = new TextDecoder().decode(bytes);
```

Assert the expected contents and caller scope against `csv`. Never scan every fake
blob for a matching header or row: an earlier export can match and hide a broken
filter or template. The same rule applies to other recorded outputs: follow the
receipt's identity, not an object left by another invocation.
Use `workspace_lang { op: 'type', type: "import('@norbital-ai/bolt/engine').Sql" }` for a type
and `typeof import('@norbital-ai/bolt/engine').Convert` for a value; hover the same names in an
unsaved probe buffer for their JSDoc and members. `workspace_lang` is the contract tool: do not
read node_modules source or use a separate docs tool.

## Scripted inference and document ingestion

Use `TestWorkspace.layer({ root, fakes: { ai: { cassette: { default: responses } } } })` for
ordered provider responses. Each response has the native `AiResponse` shape, imported as a type
from `@norbital-ai/bolt/engine`: `{ content, toolCalls: [], finish: 'stop', usage: { input: 10,
output: 5 } }`. Match `content` to the actual inference output contract. Inspect
`t.fakes.ai.requests` and `remaining()`; an unspent cassette proves inference never ran.

The converter is already an Effect service, `Convert` from `@norbital-ai/bolt/engine`.
Supply its complete layer through `TestWorkspace.layer({ root, ports: converter, ... })`:

```ts
import { Convert } from '@norbital-ai/bolt/engine';
import { Effect, Layer } from 'effect';

const converter = Layer.succeed(Convert, {
	targets: [],
	convert: () => Effect.die('This fixture must not convert a document'),
	ingest: (file) =>
		Effect.succeed({
			kind: 'document',
			html: '<p>Total 25.00</p>',
			images: [],
			meta: { stats: { pages: 1, bytes: file.bytes.length, cpuMs: 0, wallMs: 0 } }
		})
});
```

Upload a synthetic file through the actual caller, then drive the real automation and inspect
its stored proposal and unchanged business rows before confirmation. Pair success with malformed
proposal, unreadable file and refusal paths. This tests business handling of converter/model
answers; actual PDF extraction and live-model quality remain separate probes. Use `Effect.catch`
for typed failures; JavaScript `try/catch` around `yield*` does not recover an Effect failure.
An unsupported MIME is the successful port result `Effect.succeed({ unsupported: mime })`.
For a typed port failure use `Effect.fail(Port.failure('convert')({ kind: 'upstream',
message: 'Synthetic unreadable file' }))`, with `Port` from `@norbital-ai/bolt/engine`.
The host may normalize unsupported results before authored code sees them; assert the observed
stored outcome. Never erase a fixture type with a cast to force it through.

## Explicit nested edits and revision conflicts

`oss/packages/bolt/tests/write-nested-refs.integration.test.ts` checks actual native parent/child
operations. A stale child revision must conflict and leave both parent and child unchanged. Link,
unlink, update and delete have different semantics; deleting an omitted or filtered row would
violate the contract even if a simple create case passed.

For UI coverage, preserve unloaded children and submit only staged operations. Test a filtered
page and beyond-page rows rather than assuming a short fixture represents the complete relation.

## Migration replay and build integrity

`oss/packages/bolt-cli/tests/migrations.integration.test.ts` exercises migration replay and database
definitions against owned PGlite. Native PostgreSQL replay runs in deployed staging/production
acceptance. A workspace keeps numbered SQL, `snapshot.json`, `migrations.lock.json` and
`physical.json` under root `migrations/`. Builds compare replay with the declared source; checks
verify each physical prefix, and hosts apply the verified history under the SQL lock. Preserve
applied SQL and add forward migrations rather than editing historical files or proof hashes.

Artifact integrity and migration proof do not establish which revision a running host activated;
inspect the active artifact separately.

Empty replay does not prove a populated-data transformation. For a split, normalization or backfill,
include a valid row and an ambiguous row that makes a named `-- check:` query return a violation.
Exercise the actual migration application: the refusal must preserve the old rows and schema and
write no receipt for the failed file. Correct the input, retry the identical SQL, then apply it again:
the receipt must occur once and a later user edit must survive. Compare IDs, incoming references
and exact totals per currency, not only row counts or rounded display strings. The migration
integration test above covers a split and conversion from integer minor units with a live-row check.

## Stored queries and policy scope

`oss/packages/store/tests/read.test.ts` executes inline filters and cursor pages against PGlite,
including tied sort values and nulls in both directions. Include rows that match and do not match,
and more matching rows than fit on one page. Assert the exact ordered IDs, continuation termination
and refusal of a cursor reused with a different filter. A SQL string or a JavaScript filter alone
does not prove storage behavior.

Store has no member authority of its own. Verify policy application through Bolt's native caller
path, as in `oss/packages/bolt/tests/inline-policy.integration.test.ts`: use distinct policy holders
and outside-scope rows, traverse every page, and compare the full count as well as the rows. An `or`
that matches all regions must still be narrowed by the policy; negation and list conditions must
not bypass it. Pair access with a no-grant refusal. Preserve native counts when decoding answers.

For a manual migration probe, use an isolated on-disk database with synthetic data. Close and reopen
after a refused transformation and again after success; inspect the ledger, values and references,
then query the transformed inline fields. A clean reopen proves that path's persistence, not
power-loss recovery, production PostgreSQL locking, multi-host cutover or large backfill capacity.
UI acceptance additionally uses the actual artifact: filter a native table, advance pages, reload,
and repeat as an authorized and unauthorized member. Keep its evidence tied to the artifact tested.

## Controlled time

`norbital/apps/colony/tests/billing-gate.test.ts` demonstrates a cache deadline controlled by
TestClock. Its temporal assertions do not depend on machine load. Code whose timing cannot be
driven by an injected clock needs that seam added, not a real wait in the test.

## Pruning

For each assertion, name the edit that makes it fail. Replace existence-only assertions with
behaviour, remove duplicate coverage and retire tests of removed APIs. Keep deliberate gaps
visible: rendered controls, persisted state, vendor compatibility and separate-process ownership
are distinct claims: the first two are tests, the last two are probes.
