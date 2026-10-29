# Controller Surfaces

How controller apps and model forms present multi-entity, effective-dated data without
leaking system identifiers or duplicating catalogues. Complements
[interface-ideology.md](interface-ideology.md) (no duplication) and
[layout-and-scrolling.md](layout-and-scrolling.md) (one scroll owner).

## Authoring principles

These apply to every template app, representation, and custom-type renderer.

### 1. Inline even when duplicated — keep the file count small

The app (or representation) file is the unit of ownership. Prefer a longer single file over a new
shared module. Copying a `Picker` / `$derived` selection / miss → `—` expression into each page is
**intentional**.

**Do not create** (or anything like them):

| Forbidden                    | Why                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `human-label.ts`             | One-liner — write the lookup at the column                                   |
| `relationship-options.ts`    | Options belong on the `Field` that uses them                                 |
| `*-scope-select.svelte`      | A thin `Picker` wrapper — inline the picker on the page that owns the choice |
| Other one-function “helpers” | Duplication is cheaper than another import graph                             |

### 2. DRY only for a substantially big component

Extract a shared `.svelte` only when it is a **real** UI component with meaningful structure,
interaction, and reuse — not a 5–40 line wrapper around `Picker`, a Map lookup, or `bolt.query`.
If the extract is thinner than that, keep it inlined.

### 3. Declarative UI — `$derived`, never imperative wiring

A Query owns reactive reads and subscription lifetime. `$state` holds operator input;
`$derived` captures that input in `bolt.query` and derives ids, label maps and charts from current.
Check current/error/loading before choosing empty, denied or pending presentation. Do not use
`$effect` or watch to recreate reads, mirror results or synchronize query state.

```svelte
<script lang="ts">
	import { bolt } from '$bolt';
	const companyRecord = $derived(
		company === null
			? null
			: bolt.query({
					companies: { where: { id: { eq: company } }, limit: 1 }
				})
	);
	const employments = $derived(
		company === null
			? null
			: bolt.query({
					employments: { where: { company: { eq: company } }, limit: 1000 }
				})
	);
</script>
```

See [data-access.md](data-access.md#live-reads-in-a-page).

### 4. Information must be useful when displayed

Every column, field, chart key, badge, and empty state should answer an operator question. Prefer
the record's label, period + lifecycle, employee number — never raw system keys, opaque hashes, or
debug tooltips that dump ids. `code · name` is only for a code people use as a document number (a
PO number, a project number); an internal code is not shown beside the name. If a value cannot be resolved to a human label,
show `—`, not the underlying uuid.

### 5. No N+1 queries — prefer one read request with layers

Do not mount a lookup read per row. A view column that names a relation shows the target's
`label` on its own; a custom page names the relation as a declared layer in the one read request
it already makes. See [data-access.md](data-access.md#one-read-request-never-n1).

### 6. Never show system UUIDs — even for relationships

`id` and relation id values are system keys. They must not appear as text, as "… Id" labels, as
picker option labels, as a model `label`, or as fallbacks when a map misses.

| Surface                           | Required                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `Table` / `Board` relation column | name the relation (a FK or a many-relation); the target's `label` renders automatically |
| `Form` relation `Field`, `Picker` | the picker shows the target's `label`; `label`, `orderBy`, `limit`, `where` narrow it   |
| Charts / summaries                | keys are labels, never ids                                                              |

```svelte
<!-- WRONG -->
<Table of="roster_entries" columns={['id', { field: 'company', cell: idCell }]} />

<!-- RIGHT -->
<Table of="roster_entries" columns={['company', 'shift', 'work_date']} />
<Picker
	of="companies"
	label={['code', 'name']}
	orderBy="name"
	limit={500}
	value={company}
	onChange={(id) => (company = id)}
/>
```

Doctor rejects a system field (`id`, `revision`, …) as a column or field. Pass a stored
record's identity through the component's `id` prop, never through an editable field.
An update `Form` needs `id={record.id}` even when it also receives `{record}`. The `record`
prop supplies values; the `id` selects the native update target and lets the form share the
enclosing `RecordShell`'s draft, permissions and Save action. Create forms omit the id.
Matching update forms delegate their submit to the record header; do not add another Save button.
Independent forms and create forms retain their own submit action.

```svelte
<Form of="projects" mode="update" id={record.id} {record} />
```

Ordinary writes use the native form submission lifecycle. A custom control calling `bolt.act`
must distinguish a committed change from one held by an approval request (`pendingApproval`: written,
but locked until decided). After a committed state transition,
return the matching controller from `useRecordController()?.current` to view with `.view()`;
check its model and record id first. Keep refused edits (including `locked` under approval) in
their current draft, and prevent a transition while the form has unsaved changes. Do not add another draft store
or duplicate the record header. Trading Operations' revised-order seal exercises this contract.

### 7. One kind strategy on every view

`Show` and `Field` route every value through its field kind (or the custom field's
`+renderer.svelte`), in the same input-sized control frame. A view declares which fields it paints —
`Table columns`, `Board card` (at most 4 fields), `Form fields` — and never re-renders a kind by hand;
a `cell` snippet is for genuinely composite content, and its `value` is typed by the column.
`Form` edits exactly the model's `create` / `update` allowlist and sends only changed fields.

**Table cells.** Without `cell`, a column uses its field kind's default renderer in one dense line:
money formatted in its currency, file chips, a point's pin, a phone formatted, enum and state values
as labelled chips, dates in the viewer's locale and configured workspace zone, booleans as a check, json as a one-line
preview — never a raw value. A column's custom renderer is a snippet taking `{ row, value }`, both
typed (`value` is that field's type):

```svelte
{#snippet hoursCell({ row, value }: { row: RowOf<'time_entries'>; value: number | undefined })}
	<span class={value !== undefined && value > 8 ? 'text-warning' : ''}>{value ?? '—'}</span>
{/snippet}
<Table of="time_entries" columns={['employee', { field: 'hours', cell: hoursCell }, 'work_date']} />
```

**Relation columns.** Name the relation as the column. A one-relation (FK) shows the target
record's declared `label` with a link glyph; a many-relation (multi-link) shows its first label, a
stack glyph and a `+N` chip whose popover lists every linked record. A label click opens that record's
side sheet (`?record=`). Labels are read in the page's own statement (a one-relation arm, a
many-relation arm of its first 20) — never one read per row. A `cell` on a relation column receives
the FK id (one) or the related rows `{ id, …label }` (many).

**Paging.** A model `Table` reads one page at a time (`pageSize`, the viewer's choice kept per
table) by cursor, each page a live view; the footer pages, the count is one aggregate. A `Board`
lane reads its first page by its lane condition and loads the next as the lane scrolls near its
end (infinite, server-side); lane counts are one aggregate. Never pass a whole model as a local
array to get a table.

## Product rules

### Scope the surface by entity

A controller **group** that spans more than one legal entity, project, site, or account **must**
make that entity the primary scope of every sibling page — not a column mixed into an unfiltered
list.

| Pattern                                                                           | When to use                                                             |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **One group-owned live read** + the page's header `Picker` (`AppShell` `actions`) | Shared legal-entity / project / site scope across sibling pages         |
| **Entities as a `Table`**                                                         | Catalogue of legal entities; not the scope picker                       |
| **Entity breakdown** on a dashboard                                               | Cross-entity overview only (counts per entity), never mixed time series |

The live read lives in one `*.svelte.ts` module. Default is the first **in-force** row, resolved in a
`$derived`, never copied into shared state. Each page keeps its own chosen id in `$state` and reads
the resolved id with `$derived`. A read whose `status` is `loading` is unknown, not empty. Empty means
no in-force row — tell the operator to choose one in the header picker.

Declare `const day = bolt.clock('day')` during component initialization.

```svelte
<AppShell
	icon="lucide:calendar"
	title={bolt.t('roster.title')}
	description={bolt.t('roster.description')}
>
	{#snippet actions()}
		<Picker
			of="companies"
			where={{ effective: { contains: day.today } }}
			value={chosen}
			onChange={(id) => (chosen = id)}
		/>
	{/snippet}
	<Table
		of="roster_entries"
		where={company === null ? { id: { in: [] } } : { company: { eq: company } }}
		columns={['employee', 'shift', 'work_date']}
		toolbar={{ description: company === null ? bolt.t('roster.choose_company') : undefined }}
	/>
</AppShell>
```

A one-off page that is not in a group still inlines its `Picker` (principles 1–3). Do not extract a
thin `*-scope-select.svelte` wrapper around it.

Relation columns that merely _point_ at an entity inside an already-scoped page are fine.
Do not use a Company column as a substitute for scope.

### Prefill effective-dated lists to “active now”

Models with an effective `period` open **active-only** by default, as a filter the operator may
edit (not the fixed `where`):

```svelte
<Table of="employments" where={{ company: { eq: company } }} initialFilter={{ effective: { contains: day.today } }} columns={[…]} />
```

Operators may widen the filter for history. Charts and “current” summaries always use the active
window unless the page is explicitly a history view.

### One catalogue, one home (no overlapping modules)

Each model has a single controller home. Settings hold **regime and policy**; operational apps
hold **day-to-day ledgers**. Do not mount the same `Table` for the same model in two apps.

| Home                 | Owns                                                                             |
| -------------------- | -------------------------------------------------------------------------------- |
| Settings / reference | reusable configuration and catalogues, with their validation and publishing task |
| Operational app      | the records and action stream for one day-to-day responsibility                  |
| Parent record        | owned values and child records meaningful only in that parent's task             |

Use `ChildGrid` for explicit nested create/update/delete/link/unlink operations and original child revisions. A child model can stay readonly while its parent declares the child's write layer. Parent saves request native capabilities through that exact relation and the observed parent revision; independent saves use standalone child capabilities. Do not add standalone child grants to enable a parent editor: the parent's policy alone guards its layers. Custom readonly columns may show useful draft-derived values, such as each recipe line’s percentage.

If two tabs would show the same rows, delete one.

## Review checklist

1. File count: any new one-liner / `*-scope` / options helper? Delete it — duplicate inline instead.
2. DRY extract only if the component is substantially big and interactive.
3. `$derived` for queries and labels — no `$effect` / `watch` wiring.
4. Every painted value is useful to an operator (principle 4).
5. No N+1 / no gratuitous parallel label reads — a declared layer across the relation or one page-level map.
6. No uuid on screen, including relationship columns and form pickers.
7. Multi-entity pages default to one entity with an inlined toolbar selector.
8. Effective-dated tables default to `initialFilter: { <period>: { contains: day.today } }`.
9. Each model listed in only one controller app.
