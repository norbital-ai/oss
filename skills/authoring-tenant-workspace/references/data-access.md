# Data Access

Pod's sync engine maintains a local PGlite replica of policy-scoped data. Every `findMany`/
`findFirst`/`count` is a **live query** — it re-executes locally when the underlying collection
changes, with no `refetch` or `invalidate`. Mutations are **optimistic**: the UI updates same-frame;
the server confirms or rejects asynchronously. See the
[public sync-engine documentation](https://github.com/norbital-ai/oss/blob/main/packages/pod/docs/SYNC_ENGINE.md)
for architecture and invariants.

## Contents

- [Describe queries declaratively](#describe-queries-declaratively)
- [Prefer nested and inline queries](#prefer-nested-and-inline-queries)
- [Batch genuine bulk work](#batch-genuine-bulk-work)
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
	companyId != null && companies.some((c) => c.norbital_id === companyId)
		? companyId
		: (companies[0]?.norbital_id ?? null)
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
		where: { norbital_id: { eq: row.employment_id } }
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

Prefer a bulk operation over one database call per record:

```typescript
// Bad: one round trip per row.
for (const entry of entries) await api.db.roster_entries.create(entry);

// Good: one bounded bulk operation.
await api.db.roster_entries.createMany(entries);
```

Chunk only when a payload or parameter bound requires it:

```typescript
const WRITE_BATCH_SIZE = 500;

for (let start = 0; start < entries.length; start += WRITE_BATCH_SIZE) {
	await api.db.roster_entries.createMany(entries.slice(start, start + WRITE_BATCH_SIZE));
}
```

This loop is justified because every call handles a batch. Prefer one `createMany` when the complete input is
already safely bounded.

## Eliminate query-per-record loops

Collect and deduplicate keys, query once, then index the result:

```typescript
// Bad: N employments produce N database calls.
for (const employment of employments) {
	const terms = await api.db.query.employment_terms.findMany({
		where: { employment_id: { eq: employment.norbital_id } },
		limit: 5000
	});
	validateTerms(employment, terms);
}

// Good: one filtered query and O(1) lookup per employment.
const employmentIds = [...new Set(employments.map((row) => row.norbital_id))];
const terms = employmentIds.length
	? await api.db.query.employment_terms.findMany({
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
	validateTerms(employment, termsByEmployment.get(employment.norbital_id) ?? []);
}
```

If the key set cannot fit inside the normal bound, process explicit key batches. Do not add an open-ended
pagination loop merely because a table may contain more rows; narrow the business operation first.

## Treat 5,000 rows as a ceiling

Push filtering and projection into the database:

```typescript
// Bad: loads unrelated rows and columns into memory.
const allEntries = await api.db.query.time_entries.findMany({ limit: 5000 });
const periodEntries = allEntries.filter(
	(row) =>
		employmentIds.includes(row.employment_id) && row.work_date >= start && row.work_date <= end
);

// Good: returns only required rows and columns.
const periodEntries = await api.db.query.time_entries.findMany({
	where: {
		AND: [{ employment_id: { in: employmentIds } }, { work_date: { gte: start, lte: end } }]
	},
	columns: {
		norbital_id: true,
		employment_id: true,
		work_date: true,
		clock_in: true,
		clock_out: true
	},
	limit: 5000
});
```

Only `findMany` and `findFirst` belong to the Drizzle RQB namespace. Use the separate collection `count`
operation when only a count is needed. Put grouped reporting behind a typed remote backed by one
aggregation query instead of inventing an RQB method:

```typescript
const openCount = await api.db.time_entries.count({
	where: { AND: [{ employment_id: { in: employmentIds } }, { clock_out: { isNull: true } }] }
});
```

Server roles use Drizzle's query config directly, including typed `RAW` and `extras` callbacks. Browser
code uses the same `db.query.<collection>.findMany|findFirst` topology and Drizzle object syntax, but it
cannot send callbacks, SQL wrappers, placeholders, `RAW`, `extras`, or SQL comments across the remote
transport. Put those predicates or projections in a typed remote and return only the scoped result; do
not add a tagged JSON substitute to the generic query API.

Query from a selective parent when it narrows the child set:

```typescript
const employments = await api.db.query.employments.findMany({
	where: { legal_entity_id: { eq: legalEntityId } },
	columns: { norbital_id: true, employee_id: true },
	with: {
		time_entry_employment: {
			where: { work_date: { gte: start, lte: end } },
			columns: { norbital_id: true, work_date: true, clock_in: true, clock_out: true }
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
const near = await api.db.query.photo_evidence.findNearest({
	column: 'perceptual_embedding',
	probe: record.perceptual_embedding, // number[]
	metric: 'l2', // binary PDQ embedding; use 'cosine' for Gemini omni
	maxDistance: Math.sqrt(31),
	limit: 50,
	excludeIds: [record.norbital_id]
});
// each row includes `.distance`
```

`withinDistance` is the filter-only where operator; it does not drive ANN ordering — prefer
`findNearest` when you need the index path.
