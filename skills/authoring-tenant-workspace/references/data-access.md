# Data Access

Bolt's sync engine maintains a policy-scoped local replica. Every `findMany`/
`findFirst`/`count` is a **live query** — it re-executes locally when the underlying collection
changes, with no `refetch` or `invalidate`. Mutations are **optimistic**: the UI updates same-frame;
the server confirms or rejects asynchronously. See the
[bolt sync source](https://github.com/norbital-ai/oss/blob/main/packages/bolt/src/runtime/sync/sync.ts)
for the wire protocol and invariants.

## Contents

- [Describe queries declaratively](#describe-queries-declaratively)
- [Prefer nested and inline queries](#prefer-nested-and-inline-queries)
- [Batch genuine bulk work](#batch-genuine-bulk-work)
- [Write a record and what belongs to it together](#write-a-record-and-what-belongs-to-it-together)
- [Eliminate query-per-record loops](#eliminate-query-per-record-loops)
- [Treat 5,000 rows as a ceiling](#treat-5000-rows-as-a-ceiling)
- [Keep temporal filters canonical](#keep-temporal-filters-canonical)
- [Nearest-neighbor search (server-only)](#nearest-neighbor-search-server-only)

## Describe queries declaratively

`findMany` / `findFirst` / `count` return **live query handles**. The handle’s `.current` updates
when the replica changes. When _your_ filter inputs change (selected entity, date range, ids),
build the next handle with `$derived` — never `$effect` or `watch`. Templates are declarative:
`$state` for operator input; `$derived` for everything downstream.

```svelte
<!-- RIGHT -->
const selectedCompanyId = $derived(
	companyId != null && companies.some((c) => c.id === companyId)
		? companyId
		: (companies[0]?.id ?? null)
);
const rosterQuery = $derived(
	selectedCompanyId == null
		? null
		: client.db.roster_entries.findMany({
				where: { company_id: { eq: selectedCompanyId } },
				limit: 1000
			})
);
const rows = $derived(rosterQuery?.current ?? []);

<!-- WRONG: imperative side effect recreates the query -->
$effect(() => {
	rosterQuery = client.db.roster_entries.findMany({
		where: { company_id: { eq: companyId } }
	});
});
```

For controller scoping and display rules see
[controller-surfaces.md](controller-surfaces.md#authoring-principles).

## Prefer nested and inline queries

Do **not** create N+1 patterns (one query per row, or one query per relation column cell). Prefer:

1. **Nested `with`** on the primary query so related human fields arrive with each row.
2. **One** scoped label query for the page, then Map lookup in `render` — not a fan-out of parallel
   `findMany` calls for every relation that might appear.

```svelte
<!-- RIGHT: labels travel with the row -->
<CollectionTable
	query={{
		where: { employment_id: { in: employmentIds } },
		with: { agreement_employment: { columns: { employee_number: true } } }
	}}
/>

<!-- WRONG: N queries (or N parallel handles) for N rows -->
{#each rows as row}
	{@const emp = client.db.employments.findFirst({
		where: { id: { eq: row.employment_id } }
	})}
{/each}
```

Only open an extra live query when the page truly needs an independent catalogue (for example the
entity selector’s company list). Otherwise keep data on the primary query.

## Keep temporal filters canonical

Use `YYYY-MM-DD` for `date()`, `HH:mm` for `clockTime()`, and UTC ISO ending in `Z` for
`timestamp()`. Client timestamp controls convert the viewer's local input to UTC; server roles must
already supply canonical operands. Local replica and server filters must receive the same value.
See [dates-and-time.md](dates-and-time.md) for range and timezone rules.

## Batch genuine bulk work

A bulk write arrives as one admitted batch and is written in one transaction. `mutate` runs PLAN
once for the call — routing updates away from inserts, sending an approval-gated collection down the
one-row path, and cutting the rest into batches — and then, for each batch, PREPARE → FLATTEN →
COMMIT → SETTLE.

A write declaration is arranged by **how often each part runs**, and the nesting is the
documentation:

```typescript
create: {
	input,      // the shape a caller may send — an Effect Schema, decoded before any handler runs
	prepare,    // ONCE for the batch: returns data, decides nothing
	perRecord: {
		before,   // ONCE per record: validates, derives, may return a nested graph
		after     // ONCE per record: post-commit effects only
	}
}
```

`update` and `delete` take the same `perRecord` nesting. Only `create` has `prepare`, because only a
create arrives as a batch — an update is authored for one existing record and is given no view of
the call it came in on.

### `prepare` is for the batch's reads, never for its rules

A hook is authored for one record, so a hook that *reads* per record is an N+1 by construction:
`time_entries` asks two questions per row, so a four-thousand-row import asks eight thousand times.
The rule and the reads are separable, and only the reads want to be batched.

**`prepare` exists for the bulk query a person can write and a resolver cannot derive.** Four
thousand questions of the form "is `(employment, date)` covered by approved leave?" become **one**
window query over the range the batch spans, grouped into a map keyed by what a single record can
reach on its own. Merging identical queries under different keys is something a runtime can do by
itself; reformulating them into a different query is judgement about the domain, and that is exactly
what this is for.

```typescript
create: {
	prepare: ({ inputs, api }) =>
		Effect.gen(function* () {
			const employmentIds = [...new Set(inputs.map((input) => input.employment_id))];
			const dates = inputs.map((input) => input.work_date).sort();
			// One query over the window the whole batch spans, not one question per person-day.
			const requests = yield* api.db.query.leave_requests.findMany({
				where: {
					employment_id: { in: employmentIds },
					kind: { eq: 'TIME_OFF' },
					approval_id: { isNull: true },
					from_date: { lte: dates.at(-1) },
					to_date: { gte: dates[0] }
				},
				limit: 20_000
			});
			return { leaveByEmployment: groupBy(requests, (row) => row.employment_id) };
		}),
	perRecord: {
		before: {
			description: 'Refuses attendance on a day approved leave already owns.',
			// The rule is written once, for one record, and reads nothing.
			handler: ({ input, prepared }) => {
				refuseIfLeaveOwnsDay(prepared.leaveByEmployment.get(input.employment_id) ?? [], input.work_date);
				return input;
			}
		}
	}
}
```

`prepare` is **not** a second place to put the rule. It returns data; nothing decides anything there.
It is also not an alternative branch — it runs before `perRecord.before` every time, for a batch of
four thousand and for a single `create` alike, so nothing has to work out which one applies. It is
scoped to the *batch*, not the call: with `batchSize: 250` over 4,000 rows it runs sixteen times,
each seeing its own 250.

Type it by naming what it returns. The generated alias takes the parameter:

```typescript
export default { /* ... */ } satisfies Hooks<TimeEntryBatch>;
```

Cost is what this buys: facility calls per batch are **constant (~3)**, not three per row. That
property is pinned by `packages/bolt/tests/collections/mutation-facility-budget.test.ts`, which
compares 50 rows against 1 rather than against a fixed number.

### What is still true, and what changed

- **A refused `perRecord.before` fails the whole batch, with nothing written.** PREPARE and FLATTEN
  both run outside the transaction, so a refusal there costs nothing and leaves nothing half-applied.
  Write the sentence for the person who has to fix it.
- **"These rows contain a duplicate" is a unique index in `+model.ts`**, not a hook. It is stricter
  than any hook can be, because it also catches a collision with a row already stored — which a check
  over only the rows in front of it cannot see.
- **Ids are the server's.** The client no longer mints a uuid, and `create` answers with the **stored
  row** rather than with the values that were submitted — a record is not what the form posted once a
  column default, a generated column and a `perRecord.before` have run. A response with no record
  throws rather than falling back to the submission.
- **`batchHandler` is gone.** It was declared on the contract, re-typed in the runtime, and called
  from nowhere: batch validation written there shipped and silently never ran, in five collections,
  one of which had the same assertion written into both halves. It was removed rather than wired,
  because a *rule* belongs in `perRecord` where it is written once. What people actually wanted from
  it was the batched read, and that is `prepare`.

A bulk import and a single create run the same `perRecord.before`; the batch is a property of how the
write was issued, not of how the rule is written. `batchSize` is an atomicity frontier — each batch is
one transaction, so a failure loses at most one batch — and one transaction may carry at most 5,000
rows before the call is refused rather than silently split. There is no concurrency knob. Chunk only
when a payload or parameter bound requires it; do not add an open-ended pagination loop merely
because a table may contain more rows.

## Write a record and what belongs to it together

`perRecord.before` may return **more than its own columns**. A key naming a declared `many` relation
from `+relationship.ts` carries the records that belong to this one, and the parent and its children
commit in **one transaction**.

```typescript
perRecord: {
	before: {
		description: 'Expands an order into the lines it was quoted from.',
		handler: ({ input }) => ({
			...input,
			// `order_line_order` is the relation name declared in +relationship.ts — the same name
			// `with:` takes on the read side. The child's foreign key is omitted: the runtime fills
			// it from the id it assigns the parent.
			order_line_order: [{ sku: 'a-1' }, { sku: 'a-2' }]
		})
	}
}
```

Rules that hold:

- **The relation name is the declared name** in `+relationship.ts`, the same string `with:` uses. A
  `one` relation cannot be expanded inline — it points at a record that must already exist, so
  writing it would mean inventing the parent.
- **An unknown key is refused, not dropped.** TypeScript catches a misspelled relation when the
  handler returns an object literal; it cannot when the handler builds its result in a variable. So
  FLATTEN completes the guarantee: a key that is neither a column nor a declared relation fails the
  write and names the key. Nothing computed is silently lost.
- **Depth is capped at 5.** `relations` is a graph with cycles in it, and a returned graph that
  closed a loop would otherwise be walked until the isolate died. It is refused during preparation,
  with nothing written.
- The client's `create` accepts the same graph, for the same reason.

This is what replaced writing a parent and then its children in separate calls: a payroll run
committed, and *then* its payslips in a second transaction and their lines in a third — a build that
died between them left a run row with no payslips under it, which was not a hypothesis.

### Where a check goes is a correctness question

**Anything that must succeed or fail atomically with the record belongs in `perRecord.before` and the
graph it returns — never in `after`.** `after` runs in SETTLE, on the far side of COMMIT: the row is a
fact by then and nothing an `after` hook does can take it back. A failure there is a completed write
whose aftermath went wrong, which is why it is reported rather than swallowed, and why a caller must
not retry it — the phase on the failure (`prepare` │ `commit` │ `settle`) is what says which side of
the transaction it happened on.

## Eliminate query-per-record loops

Collect and deduplicate keys, query once, then index the result:

```typescript
Effect.gen(function* () {
	// Bad: N employments produce N database calls.
	for (const employment of employments) {
		const terms = yield* api.db.query.employment_terms.findMany({
			where: { employment_id: { eq: employment.id } },
			limit: 5000
		});
		validateTerms(employment, terms);
	}

	// Good: one filtered query and O(1) lookup per employment.
	const employmentIds = [...new Set(employments.map((row) => row.id))];
	const terms = employmentIds.length
		? yield* api.db.query.employment_terms.findMany({
				where: { employment_id: { in: employmentIds } },
				limit: 5000
			})
		: [];
	const termsByEmployment = new Map<string, typeof terms>();
	for (const term of terms) {
		const group = termsByEmployment.get(term.employment_id) ?? [];
		group.push(term);
		termsByEmployment.set(term.employment_id, group);
	}

	for (const employment of employments) {
		validateTerms(employment, termsByEmployment.get(employment.id) ?? []);
	}
});
```

If the key set cannot fit inside the normal bound, process explicit key batches. Do not add an open-ended
pagination loop merely because a table may contain more rows; narrow the business operation first.

## Treat 5,000 rows as a ceiling

Push filtering and projection into the database:

```typescript
Effect.gen(function* () {
	// Bad: loads unrelated rows and columns into memory.
	const allEntries = yield* api.db.query.time_entries.findMany({ limit: 5000 });
	const periodEntries = allEntries.filter(
		(row) =>
			employmentIds.includes(row.employment_id) && row.work_date >= start && row.work_date <= end
	);

	// Good: returns only required rows and columns.
	const periodEntries = yield* api.db.query.time_entries.findMany({
		where: {
			AND: [{ employment_id: { in: employmentIds } }, { work_date: { gte: start, lte: end } }]
		},
		columns: {
			id: true,
			employment_id: true,
			work_date: true,
			clock_in: true,
			clock_out: true
		},
		limit: 5000
	});
});
```

Only `findMany` and `findFirst` belong to the Drizzle RQB namespace. Use the separate collection `count`
operation when only a count is needed. Put grouped reporting behind a typed remote backed by one
aggregation query instead of inventing an RQB method:

```typescript
const openCount =
	yield *
	api.db.query.time_entries.count({
		where: { AND: [{ employment_id: { in: employmentIds } }, { clock_out: { isNull: true } }] }
	});
```

Every server-role example above runs inside a hook, automation, remote, or pipeline handler — an `Effect.gen` where `api.db.*` calls are `yield*`'d. Server roles use Drizzle's query config directly, including typed `RAW` and `extras` callbacks. Browser
code uses the same `db.query.<collection>.findMany|findFirst` topology and Drizzle object syntax, but it
cannot send callbacks, SQL wrappers, placeholders, `RAW`, `extras`, or SQL comments across the remote
transport. Put those predicates or projections in a typed remote and return only the scoped result; do
not add a tagged JSON substitute to the generic query API.

Query from a selective parent when it narrows the child set:

```typescript
const employments =
	yield *
	api.db.query.employments.findMany({
		where: { legal_entity_id: { eq: legalEntityId } },
		columns: { id: true, employee_id: true },
		with: {
			time_entry_employment: {
				where: { work_date: { gte: start, lte: end } },
				columns: { id: true, work_date: true, clock_in: true, clock_out: true }
			}
		},
		limit: 5000
	});
```

## Nearest-neighbor search (server-only)

`findNearest` runs on the tenant Postgres with pgvector (`ORDER BY column <op> probe`) against a
`vector(n)` column. Available on hook / remote / automation `api.db.query.<collection>` only — not
on the browser client. Metrics: `cosine`, `l2`, `ip`.

```typescript
const near =
	yield *
	api.db.query.photo_evidence.findNearest({
		column: 'perceptual_embedding',
		probe: record.perceptual_embedding, // number[]
		metric: 'l2', // binary PDQ embedding; use 'cosine' for Gemini omni
		maxDistance: Math.sqrt(31),
		limit: 50,
		excludeIds: [record.id]
	});
// each row includes `.distance`
```

`withinDistance` is the filter-only where operator; it does not drive ANN ordering — prefer
`findNearest` when you need the index path.
