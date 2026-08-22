# Controller Surfaces

How controller apps and collection forms present multi-entity, effective-dated data without
leaking system identifiers or duplicating catalogues. Complements
[interface-ideology.md](interface-ideology.md) (no duplication) and
[layout-and-scrolling.md](layout-and-scrolling.md) (one scroll owner).

## Authoring principles

These apply to every template app, representation, and custom-type renderer.

### 1. Inline even when duplicated — keep the file count small

The app (or representation) file is the unit of ownership. Prefer a longer single file over a new
shared module. Copying a Combobox / `$derived` selection / miss → `—` expression into each app is
**intentional**.

**Do not create** (or anything like them):

| Forbidden                              | Why                                                    |
| -------------------------------------- | ------------------------------------------------------ |
| `human-label.ts`                       | One-liner — write the lookup at the column             |
| `relationship-options.ts`              | Options belong on the `Field` that uses them           |
| `*-scope.ts` / `*-scope-select.svelte` | Inline the Combobox + `$derived` selection in each app |
| Other one-function “helpers”           | Duplication is cheaper than another import graph       |

### 2. DRY only for a substantially big component

Extract a shared `.svelte` only when it is a **real** UI component with meaningful structure,
interaction, and reuse — not a 5–40 line wrapper around Combobox, Map lookup, or `findMany`.
If the extract is thinner than that, keep it inlined.

### 3. Declarative UI — `$derived`, never imperative wiring

Live queries already re-run when the replica changes. Author templates as a function of state:
`$state` for operator input only; `$derived` for resolved ids, query handles, label maps, charts,
and empty states. Do **not** use `$effect` or `watch` to recreate queries or “sync” UI.

```svelte
<!-- RIGHT -->
const employmentsQuery = $derived(
	selectedCompanyId == null
		? null
		: client.db.employments.findMany({
				where: { company_id: { eq: selectedCompanyId } },
				limit: 1000
			})
);

<!-- WRONG -->
watch(
	() => companyId,
	(id) => {
		employmentsQuery = id == null ? null : client.db.employments.findMany({ … });
	}
);
```

See [data-access.md](data-access.md#describe-queries-declaratively).

### 4. Information must be useful when displayed

Every column, field, chart key, badge, and empty state should answer an operator question. Prefer
`code · name`, period + lifecycle, employee number, project number · name — never raw system keys,
opaque hashes, or debug tooltips that dump ids. If a value cannot be resolved to a human label,
show `—`, not the underlying uuid.

### 5. No N+1 queries — prefer nested / inline queries

Do not mount a lookup query per row. Prefer:

1. **`query.with`** on the table/form so related labels arrive with the rows, or
2. **One** `$derived` label query for the scoped page, then Map lookup in `render`.

Avoid spraying many parallel `findMany` calls “just in case.” Usually one scoped query (or one
parent + nested `with`) is enough. See [data-access.md](data-access.md#eliminate-query-per-record-loops).

### 6. Never show system UUIDs — even for relationships

`id` and FK uuid values are system keys. They must not appear as text, as “… Id” labels,
as Combobox option labels, as `recordLabel` fields, or as fallbacks when a map misses.

| Surface               | Required                                                                   |
| --------------------- | -------------------------------------------------------------------------- |
| Table relation column | Human label / nested relation; miss → `—`                                  |
| Form relation `Field` | Explicit human `label` + `RelationshipRenderer` with human `options.label` |
| Auto `CollectionForm` | Forbidden when the schema has uuid FKs — author `+representation.svelte`   |
| Charts / summaries    | Keys are labels (`code · name`), never ids                                 |

```svelte
<!-- WRONG -->
<Column name="company_id" render={({ value }) => labels.get(String(value)) ?? value} />
<Field name="company_id" />

<!-- RIGHT — inlined at the call site -->
<Column
	name="company_id"
	label="Company"
	render={({ value }) => (value == null || value === '' ? '—' : (labels.get(String(value)) ?? '—'))}
/>
<Field
	name="company_id"
	label="Company"
	renderer={RelationshipRenderer}
	rendererProps={{
		target: 'companies',
		options: {
			label: (record) => (record.name != null && record.name !== '' ? String(record.name) : '—'),
			orderBy: { name: 'asc' },
			limit: 500
		}
	}}
/>
```

Stupidity scanner **UI17** flags common violations (`?? value` on id columns, `label="… Id"`,
`Column name="id"`, bare `Field name="*_id"`).

## Product rules

### Scope the surface by entity

A controller app that spans more than one legal entity, project, site, or account **must** make that
entity the primary scope of the page — not a column mixed into an unfiltered list.

| Pattern                                             | When to use                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| **Entity selector** in the page header / above tabs | Operational boards: payroll, roster, leave, claims, charts, approvals   |
| **Entity breakdown** on a dashboard                 | Cross-entity overview only (counts per entity), never mixed time series |

Default the selector to the first **active** entity. Every `CollectionTable` query, chart remote,
and summary filters by the selected entity. Clearing the selector (when offered) is an explicit
“all entities” choice — never the default.

Inline the selector in the app (see principles 1–3):

```svelte
<script lang="ts">
	let companyId = $state<string | null>(null);
	const today = todayKey();
	const activeRange = { effective_range: { contains_date: today } } as const;

	const companiesQuery = client.db.companies.findMany({
		where: { approval_id: { isNull: true }, ...activeRange },
		orderBy: { name: 'asc' },
		limit: 500
	});
	const companies = $derived(companiesQuery.current ?? []);
	const companyOptions = $derived(
		companies.map((company) => ({
			value: company.id,
			label: company.name,
			search_term: company.name
		}))
	);
	const selectedCompanyId = $derived(
		companyId != null && companies.some((company) => company.id === companyId)
			? companyId
			: (companies[0]?.id ?? null)
	);
</script>

{#snippet companyScopeActions()}
	<label class="grid gap-1.5 text-sm">
		<span class="font-medium text-muted-foreground">Legal entity</span>
		<Combobox
			ariaLabel="Legal entity"
			options={companyOptions}
			value={selectedCompanyId}
			onValueChange={(value) => {
				companyId = typeof value === 'string' ? value : (companies[0]?.id ?? null);
			}}
			emptyPlaceholder="Select legal entity…"
			searchPlaceholder="Search companies…"
			clientConfig={{
				isLoading: companiesQuery.loading,
				error: companiesQuery.error?.message ?? null
			}}
			class="min-w-[16rem]"
		/>
	</label>
{/snippet}

<PageHeader title="Scheduling" actions={companyScopeActions} />
{#if selectedCompanyId == null}
	<p class="text-sm text-muted-foreground">Select a legal entity…</p>
{:else}
	<CollectionTable
		collection="roster_entries"
		query={{ where: { company_id: { eq: selectedCompanyId } } }}
	/>
{/if}
```

Relation columns that merely _point_ at an entity inside an already-scoped page are fine.
Do not use a Company column as a substitute for scope.

### Prefill effective-dated lists to “active now”

Collections with `effective_range` (or equivalent validity) open **active-only** by default.
Write the filter inline:

```ts
query={{
  where: {
    company_id: { eq: selectedCompanyId },
    effective_range: { contains_date: todayKey() }
  }
}}
```

Operators may widen the filter for history. Charts and “current” summaries always use the active
window unless the page is explicitly a history view.

### One catalogue, one home (no overlapping modules)

Each collection has a single controller home. Settings hold **regime and policy**; operational apps
hold **day-to-day ledgers**. Do not mount the same `CollectionTable` for the same collection in two
apps.

| Home                    | Owns                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| Settings / reference    | Jurisdictions, statutory contributions & rates, overtime rules/limits, companies |
| People                  | Employments, terms, statutory facts about people                                 |
| Pay components          | Pay catalogue **and** the entry stream                                           |
| Scheduling              | Shifts, roster, holidays                                                         |
| Leave / Payroll / Loans | Their operational collections only                                               |

If two tabs would show the same rows, delete one.

## Review checklist

1. File count: any new one-liner / `*-scope` / options helper? Delete it — duplicate inline instead.
2. DRY extract only if the component is substantially big and interactive.
3. `$derived` for queries and labels — no `$effect` / `watch` wiring.
4. Every painted value is useful to an operator (principle 4).
5. No N+1 / no gratuitous parallel label queries — nested `with` or one page-level map.
6. No uuid on screen, including relationship columns and form pickers.
7. Multi-entity pages default to one entity with an inlined selector.
8. Effective-dated tables default to `contains_date: today`.
9. Each collection listed in only one controller app.
