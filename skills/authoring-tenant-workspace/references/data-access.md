# Data access

Use `query` for every read form, in pages and server code. Keep ids, decimals and date values in
the types the platform supplies; decode unknown provider/file inputs once at their boundary.

An id that arrives as text (a URL parameter, a JSON payload, a provider's reply) decodes once with
`idOf(model)` from `@norbital-ai/bolt`: a `Schema` from a non-empty string to that model's branded
`Id<'model'>`. Never cast a string to `Id<…>`.

```ts
import { Schema } from 'effect';
import { idOf } from '@norbital-ai/bolt';

const employee = yield * Schema.decodeUnknownEffect(idOf('employee'))(params.get('employee'));
```

## The read shapes

```ts
bolt.query({ orders: { where: { status: { eq: 'draft' } }, limit: 50 } });
bolt.query({ orders: { where: { id: { eq: id } }, limit: 1 } }); // one record
bolt.query({ trials: { search: { colour: input }, limit: 20 } }); // an index search
bolt.query({
	orders: { where: { customer: { eq: customer } }, fields: ['number', 'total', 'customer'] },
	'orders.customer': { fields: ['name'] },
	'orders.lines': { where: { quantity: { gt: 0 } }, limit: 50 },
	commercial_settings: { limit: 1 }
});
// → { orders: { rows: [{ id, number, total, customer: { id, name } | null, lines: [...] }], next, total },
//     commercial_settings: { rows, next, total } }
```

A root page's `total` counts every row the read matches (policy, `where`, text search) whatever
its `limit` and `after`, in the same statement, live with the page: "rows 1–50 of 1,284" needs no
second count. An index search root has none, and a nested many-layer carries none per parent: an
`aggregate` on that layer counts it. The count scans every matching row, so it costs time linear
in the match.

Every read is a **read request**, one JSON layer map. Each key without a dot is a root (a model
with `read`), at most once per request. A root reads one of its model's outputs (`output`, `default`
when absent), which a held policy must grant; a deep key is a layer of that output and implies its
parents. A layer takes `where`, `fields`, `orderBy`, `limit`, `search` and `aggregate`; only a root
takes `output`, `after` and `asOf`. A named ref layer replaces its FK with the row or `null`; a many-layer is
its rows. The output fixes the fields; only the root's policy filters the rows of the whole tree,
and a user filter composes with it per key (`where` AND, `limit` capped), so nothing widens it.

```ts
bolt.query({
	orders: { output: 'logistics', where: { status: { eq: 'placed' } } },
	'orders.lines': {}
});
```

`ctx.query` takes the same request as an Effect, `tx.query` too (no `asOf`). A prior revision of
one record is `bolt.history` on a page, or a root `asOf` instant in server code. Write callbacks, policy
checks and notify use `ctx.db.query` for whole-row workspace reads; other bodies read as the caller, an automation as its
`policies`, an effect as its writer. File sync reads retain their importing/exporting caller's scope and outputs; remote syncs read as trusted
workspace. Context never elevates authority. Every list (a root page, or a many-layer per parent
row) defaults to `limit` 10,000 and the root's default order; page on with the root's `after`.
Complete reads
past the row/byte cap fail `TooLarge`, never silently truncate. Push filtering/projection into
SQL rather than reading wide rows and filtering them in memory.

## Live reads in a page

```svelte
<script lang="ts">
	import { bolt } from '$bolt';
	let { company } = $props();
	const companyRecord = $derived(
		company === null
			? null
			: bolt.query({ companies: { where: { id: { eq: company } }, limit: 1 } })
	);
	const employments = $derived(
		company === null
			? null
			: bolt.query({
					employments: {
						where: { company: { eq: company } },
						fields: ['role', 'employee'],
						limit: 500
					},
					'employments.employee': { fields: ['name', 'email'] }
				})
	);
</script>

{#if employments?.current}
	{#each employments.current.employments.rows as employment (employment.id)}
		<p>{employment.employee?.name ?? '—'} · {employment.role}</p>
	{/each}
{:else if employments?.error}<p role="alert">{employments.error.message}</p>
{:else if employments?.loading}<p>Loading…</p>{/if}
```

A Query subscribes on its first reactive read of current/loading/error, or await in async
Svelte markup/derived code. Identical calls share a subscription; it stops after its last reader
leaves, with 30 s grace. `$derived` captures changed inputs. Derive presentation directly; do not
mirror the answer/loading/error into another `$state`, create a subscription `$effect`, or own
per-query timers and generation counters. Return null to represent no selected query.

## One-shot reads in a page

Outside a reactive context, await reads once. The same Query implements Effect for composition.

```ts
async function exportOrders() {
	const { orders } = await bolt.query({
		orders: { where: { status: { eq: 'placed' } } }
	});
	return orders.rows;
}
```

Mutations retain their own operation state and execute through `fork` or `run` from `$bolt`.
Keep Effects outside Svelte state. Source subscriptions belong to Query, mounted element
resources to `attach`, and mutation errors to the operation that caused them.

## Explicit time and initial server data

Use `const day = bolt.clock('day')` and pass `day.today` as a literal query input, or a minute/hour
clock's `now`. A live clock ticks only while visible; no-argument `bolt.clock()` is a fixed
page-opening snapshot. Write callbacks and automations use invocation-bound `ctx.today`/`ctx.now`;
a `src/lib` helper takes time as an argument and has no clock. Read predicates and grant
scopes have no time variables. See [dates and time](dates-and-time.md).

A value position may instead hold `{ field: '<column>' }` (a same-row column) or `{ var: '<CEL>' }`, a
typed expression over `requestor` (`id`, `email`, `phone`, `party`, `visitor`, `instance`, `teams`,
`teamTree`, `scopes.<policy>`) and the clock (`today`, `now`), evaluated once per read and checked
against the field's kind: `{ owner: { eq: { var: 'requestor.id' } } }`,
`{ team: { in: { var: 'requestor.teamTree' } } }`. Time expressions (`today - days(7)`,
`startOfMonth(today)`, `now - hours(1)`) are edge-only: the view filter, the agent's read and described
filters evaluate them before reading; the store refuses them.

Public/external SSR pages load their initial data through `pageServer.load` with an ordinary
shared data codec, then render it synchronously. Return only caller-authorized data. Hydration
uses that same codec and caller; page reads after mount use Query. Do not conceal loaded content
behind a second browser read or create a competing query state machine. Keep device work out of
server rendering. See [apps and server roles](apps-and-server-roles.md#public-and-external-rendering).

## One read request, never N+1

A relation column renders its target's label natively. A custom page reads related data as the
root's declared layers in its one read: a ref layer is an object (or null when its `where` excludes
it), a many-layer is a list per parent row. Never mount one lookup per row or cell. Reads started
in the same microtask batch into one round trip and one SQL statement; identical reads deduplicate.

```ts
const { employment_contract, entity, payslip } =
	yield *
	ctx.query({
		employment_contract: { where: { company_id: { eq: id } } },
		entity: { where: { id: { eq: id } }, limit: 1 },
		'entity.settings': {},
		payslip: { where: { company_id: { eq: id } }, fields: ['net'], limit: 500 }
	});
```

Each root is a model, named once, under current authority and its own page cap; derive several
views of the same rows on the client. A read that depends on another row's field is a layer: the
relation is a ref the model declares (`entity.settings` above), named in its `read`, and the
dependent rows come back nested in the same statement.

## Read, then transform in `src/lib`

A model declares no named queries. A computed answer (an ageing table, a preview, a statement) is
one read request plus a pure, browser-safe helper in `src/lib/` typed over the answer's rows. The
page calls `bolt.query({...})` and then the helper in `$derived`; server code calls the same helper
over `ctx.query({...})`. Add the layers the helper needs to the root's `read` and narrow them in the
root's policy where a reader must not see them. Server-side checks stay in write callbacks, so a
client-side preview is safe. An export too heavy for the page is a `with: 'file'` sync.

```ts
// src/lib/ar-aging.ts: pure and browser-safe, no `$bolt` or ctx import
import type { PlainDate } from '@norbital-ai/std/date';
export function overdue<R extends { readonly due_on: PlainDate | null }>(
	rows: readonly R[],
	today: PlainDate
) {
	return rows.filter((row) => row.due_on !== null && row.due_on < today);
}

// page
const day = bolt.clock('day');
const book = $derived(
	bolt.query({
		orders: { where: { status: { eq: 'issued' } }, fields: ['number', 'total', 'due_on', 'party'] },
		'orders.party': { fields: ['name'] }
	})
);
const late = $derived(book.current && overdue(book.current.orders.rows, day.today));

// automation or file sync: the same helper over the same request
const { orders } = yield * ctx.query({ orders: { where: { status: { eq: 'issued' } } } });
const lateNow = overdue(orders.rows, ctx.today);
```

## Batch: read once, decide per input

`create.transform` receives rows; `update.transform` receives before/set changes. Compute every id
needed before mapping, prefetch in at most two `ctx.db.query` reads, then decide per row without
crossings. Keep branded ids from the inputs; never cast strings to make an invalid query compile.
The engine prefetches before/delete/upsert rows. All nested children run their own callbacks.
Each 1000-row chunk has one callback per verb/model, its own 3 s CPU budget, and set-based writes;
the entire file is one transaction. See [models](models-and-modeling.md#write-callbacks).

## Write a record and what belongs to it together

Every generated write takes an array (`[{ … }]`, `[{ target, set }]`, `[{ target }]`), so the
model's callbacks and the policy check see the whole batch. A parent and its children belong in
one act through the model's write layers: a create row carries each child layer as an array (an id
links an existing non-owned row); an update `set` carries per child layer
`{ create, update: [{ target, set }], delete, link, unlink }`. Nothing is deleted by omission.
Independent writes that must commit together use one
`ctx.act.many(...)` call; dependent creates use the parent's write layers. A durable
automation can contain several transactions, so retain values and pass observed revisions
when a later write depends on an earlier read.
For dynamically assembled JSON inputs, `ctx.act.checked(...)` keeps the same atomic batch
and native input validation; its outputs remain JSON. Prefer `many` when inputs are statically typed.

When writes depend on a current read or on an earlier write, use the native transaction generator:

```ts
import { Refusal } from '@norbital-ai/bolt/errors';

// prettier-ignore
const result = yield* ctx.transaction(function* (tx) {
    const { accounts } = yield* tx.query({
      accounts: { where: { id: { eq: input.account } }, limit: 1 },
    });
    const account = accounts.rows[0];
    if (account === undefined)
      throw new Refusal({ message: "Account is unavailable." });
    const balance = account.balance.minus(input.amount);
    if (balance.lt(0)) throw new Refusal({ message: "Insufficient balance." });
    yield* tx.act("accounts.update", [{ target: account.id, set: { balance } }]);
    yield* tx.act("ledger_entries.create", [{
      account: account.id,
      amount: input.amount.neg(),
    }]);
    return balance;
});
if (result.kind === 'committed') {
	// result.output is the final balance; result.records names every committed row.
} else {
	// result.requestId names the held approval; there is no committed callback output.
}
```

This example assumes decimal balance/amount fields and the corresponding read/write grants.
`tx.query` takes a read request over current rows; it sees earlier session writes.
`tx.act` uses the standard guards, callbacks, state and approval rules. Its inner answers have
provisional output/records and no committed kind. The outer answer commits everything once or
holds the writes for approval; a refusal or failure rolls everything back. Observations belong
to the session, so do not pass manual revision maps. Upserts still require `onConflict`.

The fixed five-second session requires PostgreSQL 17+; PGlite explicitly refuses it. Yield only
`tx.query` and `tx.act` inside the synchronous generator. Facilities, captured outer ctx Effects,
raw SQL, nesting and async callbacks are forbidden; finish external work first. Return native
values or void, with no Promise or function payloads. The platform never automatically replays
the callback.

An automation that reads, waits for external computation, then writes must carry the observed
revision: `ctx.act('jobs.update', [{ target: job.id, set: { extracted } }],
{ observed: { [job.id]: job.revision } })`. A newer edit conflicts instead of being overwritten.
Nested relation writes preserve the outer observation. Handle committed versus pendingApproval honestly;
the latter has written provisionally but remains held by the request.

## Aggregates, not loops

Counts, sums and groupings prefer a read-request root or layer `aggregate`, else `bolt.aggregate` or count/sum
roll-up fields. Ungrouped aggregate
returns one object (`count` only when asked) and grouped aggregate is paged: each bucket carries its `key`
and row `count`, with or without other measures. It shares Query's live/once contract. Server
calculations use the same root `aggregate` in `ctx.query({...})`, or roll-ups.
Shared Table/Board counts describe the full authorized scope, not just the loaded cards. Reuse
them instead of adding a counter or polling loop. A figure reused across screens belongs in a
roll-up or a shared `src/lib` helper over one read request.

## Search

Declare text, semantic and custom indexes under model.search. Call the same query API with
`{ search: { index: input }, limit }`. The probe's where narrows inside the scan, the read output
and caller grants apply, and pure rerank orders candidates. The engine maintains derived vectors; an
automation owns vectors that need I/O. The toolbar exposes index forms automatically.
