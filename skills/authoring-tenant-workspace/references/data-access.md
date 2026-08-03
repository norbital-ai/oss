# Data Access

Pod's sync engine maintains a local PGlite replica of policy-scoped data. Every `findMany`/
`findFirst`/`count` is a **live query** — it re-executes locally when the underlying collection
changes, with no `refetch` or `invalidate`. Mutations are **optimistic**: the UI updates same-frame;
the server confirms or rejects asynchronously. See the
[public sync-engine documentation](https://github.com/norbital-ai/oss/blob/main/packages/pod/docs/SYNC_ENGINE.md)
for architecture and invariants.

## Contents

- [Batch genuine bulk work](#batch-genuine-bulk-work)
- [Eliminate query-per-record loops](#eliminate-query-per-record-loops)
- [Treat 5,000 rows as a ceiling](#treat-5000-rows-as-a-ceiling)
- [Keep temporal filters canonical](#keep-temporal-filters-canonical)

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
