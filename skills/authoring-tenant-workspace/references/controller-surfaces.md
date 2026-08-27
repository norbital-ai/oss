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

1. Let a declared table/Kanban relationship field add its automatic `query.with`, or
2. **One** `$derived` label query for a genuinely composite explicit renderer or whole `Card`
   override.

Avoid spraying many parallel `findMany` calls “just in case.” Usually one scoped query (or one
parent + nested `with`) is enough. See [data-access.md](data-access.md#eliminate-query-per-record-loops).

### 6. Never show system UUIDs — even for relationships

`id` and FK uuid values are system keys. They must not appear as text, as “… Id” labels,
as Combobox option labels, as `recordLabel` fields, or as fallbacks when a map misses.

| Surface               | Required                                                                   |
| --------------------- | -------------------------------------------------------------------------- |
| Table relation column | Declare the column; automatic relation label, optional `relationOptions`   |
| Form relation `Field` | Declare the field; automatic picker, optional contextual `relationOptions` |
| Kanban relation field | Declare the field; automatic relation label, optional `relationOptions`    |
| Charts / summaries    | Keys are labels (`code · name`), never ids                                 |

```svelte
<!-- WRONG -->
<Column
	name="company_id"
	renderer={FormattedValueRenderer}
	rendererProps={{ format: ({ value }) => labels.get(String(value)) ?? String(value) }}
/>
<Field name="id" hidden />

<!-- RIGHT — the relationship strategy is automatic; only contextual options are authored -->
<Column name="company_id" label="Company" />
<Field
	name="company_id"
	label="Company"
	relationOptions={{
		label: (record) => (record.name != null && record.name !== '' ? String(record.name) : '—'),
		orderBy: { name: 'asc' },
		limit: 500
	}}
/>
```

Doctor **UI17** rejects system-field composition such as `<Column name="id">` and even
`<Field name="id" hidden>`. Form identity is framework-hidden automatically; authors never declare
it.

### 7. One datatype strategy on every collection surface

`DataRenderer` is the single routing boundary. Its precedence is: explicit `renderer` override,
relationship strategy, custom datatype renderer, built-in datatype renderer/fallback. Every branch
is mounted in the same input-sized control frame; a renderer may be directly mutable or use a
trigger + dropdown, but it does not invent a different surface height.

| Surface            | Authoring contract                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CollectionTable`  | `columns` is required. An absent `<Column>` is omitted; no `renderer` means automatic; `renderer` is the only field-content override and still runs through the standard control frame. System fields cannot be declared.                                                                                                                                                                                                                                 |
| `CollectionKanban` | `fields` is required. The automatic card uses only declared `<Field>` entries and the same renderer options. `Card` is the explicit whole-card override. System fields cannot be declared or used as collapsed-card content.                                                                                                                                                                                                                              |
| `CollectionForm`   | `children` is required. Every mutable model field must occur exactly once. Use `<Field hidden>` for a value supplied by custom composition or a collection hook; it registers without painting a control or running visible-input required checks. Missing/duplicate fields throw at runtime. System fields, including `id`, are internal and already hidden. Generated read-only fields may be declared for display but do not satisfy the mutate shape. |
| Toolbar filters    | No templated overrides. The field tree is automatic: root attributes plus attributes reached through one or two relationship edges. Operand controls and applied values use the same datatype strategy.                                                                                                                                                                                                                                                   |

Do not pass `RelationshipRenderer` explicitly for an ordinary relationship, do not use the removed
table `render` prop, and do not rely on schema declaration order to create table or card fields.

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
