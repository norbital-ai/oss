# App Structure

Where things go on a page. Each kind of thing has one home, so two apps built by two authors look like
one product. Layout mechanics are in [layout-and-scrolling.md](layout-and-scrolling.md); who pads is
in [padding-and-spacing.md](padding-and-spacing.md).

## The page is its subject

A page whose subject is a model **is** that view. It does not get a heading card that restates
the selected item, a paragraph above the view, or a button row above the view — what the view is for
goes in the toolbar's ⓘ `description`. The toolbar `title` is 1–3 words. The toolbar is one row:
title, ⓘ, then every widget (`toolbar.controls`, search, filter, ⚡) flush left; the create button
(New / Add row) alone sits flush right, and stays last when the row wraps at phone width. The kit
lays it out — a slot never moves. Everything else has a slot:

| You want to show…                                                                                 | It goes in…                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| app identity (title, description, icon, banner)                                                   | `AppShell` props — the hero renders them once                                                                 |
| page scope (company, entity, site, period, month)                                                 | `AppShell`'s `actions` snippet: one set of pickers in the header that every view and tab on the page reads    |
| a view-local presentation control (a grouping, a lane toggle)                                     | the view's `toolbar.controls` snippet — never scope                                                           |
| every page-level operation (run, import, export, a template download, bulk change, a view toggle) | the view's ⚡ actions menu: `toolbar.actions`                                                                 |
| operations on one row                                                                             | the view's row `actions`: start an explicitly granted automation or call a standard guarded write verb        |
| operations on one record                                                                          | `RecordShell`'s `actions` snippet — the record sheet header                                                   |
| a run's progress                                                                                  | the toolbar shows the run of an item whose `run` returns `bolt.start(…)`; `RunStatus` / `RunsFor` elsewhere   |
| creating a record                                                                                 | the toolbar's New (`toolbar.new`), which opens `RecordShell mode="create"`                                    |
| filtering and sorting                                                                             | the toolbar's filter-and-sort popover; the author's fixed scope is `where`, a starting filter `initialFilter` |
| the row range and paging                                                                          | the table's own footer — never under the toolbar                                                              |

Never re-implement a slot: a hand-made "Run now" button, a search box, a `<select>` above a table, a
description paragraph, or a custom action bar is a second spelling of something the view already
renders, and it drifts. **The toolbar owns every page-level action**: no button sits in the app
header, above a view or beside it. The header's `actions` slot holds the page scope pickers only.

### The toolbar's actions menu

The ⚡ menu lists remote Sync now, the model's file syncs' Import, Export and
Download template, and Delete selected. Each file operation starts `<model>.sync.<name>` with
the operation's context; no page wiring is needed. Each row is an icon, a name, a description and its button.

`toolbar.actions` adds the page's own rows. An item is configuration: `icon` (an Iconify id),
`name`, `description` (optional, one line under the name) and the handler `run(selected)`. The menu
works out the row's state from what `run` returns:

| `run` returns                                              | the row                                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| nothing (it opened a sheet or a file picker)               | closes the menu                                                                                                           |
| an Effect                                                  | spinner and disabled until it settles, then Done; a typed failure is the row's error, in place and as a toast             |
| an Effect from `bolt.act(…)`                               | its committed or pending-approval result is toasted; `ActRefused`, `ActConflict` and `ActUnknown` use the failure channel |
| an Effect from `bolt.start(…)`, with `id` and `automation` | the run's live status under the toolbar                                                                                   |

A `CustomView` that draws one model's records names its backing model through the view's declared model source (a roster grid of
`roster_entry`). Its ⚡ menu then offers that model's file syncs, its title
defaults to the model's label, and New opens the model's create unless `toolbar.new` is
`false`. The search still runs over the view's own rows and columns.
`toolbar.context` (`{ company_id, period }`) is what the view is scoped to; the model's file
syncs (Import…, Download template) receive it. `requiresSelection: true` lists the item under Bulk and turns row selection on;
`disabled: (selected) => string | null` says why it cannot run now (shown instead of the description).
Never toast or track a spinner for a menu item yourself.

For client-generated text documents, use `downloadTextFiles(documents, 'export.zip')` from
`@norbital-ai/ui`. One file downloads directly; multiple files become one ZIP with distinct names.
Do not loop over download clicks: a browser can silently save only part of a large batch. Read
the selected rows and the layers the files need in one read request, then build the documents
with a pure `src/lib` helper the server can reuse, as below. An export too heavy for the page is
a `with: 'file'` sync, which the menu already offers as Export.

For a custom record-header action outside the toolbar, pass its resolved typed outcome to
`notifyOutcome(bolt, outcome)` from `@norbital-ai/ui`. It uses the same localized feedback as Form
and toolbar actions. It does not own the request, pending state or transport-error handling.

```svelte
<script lang="ts">
	import { Effect } from 'effect';
	import { bolt } from '$bolt';
	import type { Id } from '@norbital-ai/bolt';
	import { Table, downloadTextFiles } from '@norbital-ai/ui';
	import { AppShell } from '@norbital-ai/ui/layout';
	import { bankFiles } from '../../../lib/payroll/bank_files.js'; // pure: rows in, documents out
	// scope, companyPicker and t come from this page's controls and messages.
	const exportRuns = (ids: readonly Id<'payroll_run'>[]) =>
		bolt
			.query({
				payroll_run: { where: { id: { in: ids } }, fields: ['period', 'pay_date'] },
				'payroll_run.payslips': { fields: ['employee', 'net', 'bank_account'] },
				'payroll_run.payslips.employee': { fields: ['name'] }
			})
			.pipe(
				Effect.tap(({ payroll_run }) =>
					Effect.sync(() => downloadTextFiles(bankFiles(payroll_run.rows), 'payroll-exports.zip'))
				)
			);
</script>

<AppShell icon="lucide:receipt" title={t('app.payroll.runs_title')}>
	{#snippet actions()}{@render companyPicker()}{/snippet}
	{#if scope.id !== null}
		<Table
			of="payroll_run"
			where={{ company_id: { eq: scope.id } }}
			columns={['period', 'kind', 'pay_date']}
			toolbar={{
				title: t('app.payroll.runs_title'),
				actions: [
					{
						icon: 'lucide:download',
						name: t('app.payroll.export'),
						requiresSelection: true,
						run: exportRuns
					}
				]
			}}
		/>
	{/if}
</AppShell>
```

### A custom view gets the same toolbar

A view that is not a `Table`, `Board`, `Map` or `Pivot` (a roster grid, a calendar, cards) renders
`CustomView`: the same title and info popover, search, filter-and-sort over its own rows, ⚡ menu and
`controls`; the body snippet receives the rows they leave.

```svelte
<CustomView
	of={people}
	key="roster"
	fields={[
		{ field: 'number', label: t('number') },
		{ field: 'name', label: t('name') }
	]}
	toolbar={{ title: t('roster.title'), description: t('roster.help'), actions: rosterActions }}
>
	{#snippet children(shown)}<RosterGrid people={shown} />{/snippet}
</CustomView>
```

## AppShell and the header

Every page is an `AppShell`. Its `title`, `description`, `icon` and `banner` feed the hero, so a
heading that repeats them is duplication — use a heading only for a sub-view the hero does not
already name. The page scope pickers go in its `actions` snippet; operations go in the view's toolbar, never a second
header row.

```svelte
<AppShell icon="lucide:users" title={bolt.t('people.title')} description={bolt.t('people.description')} variant="full">
	<Tabs tabs={[…]} />
</AppShell>
```

The header's company picker scopes every tab's view; its value scopes the query, and placing a
picker does not itself authorize data access.

`variant="page"` (default) pads the body — use it for one view. `variant="full"` leaves the body to
`Tabs` or a `Scroll inset`. Across pages, the app's nav is `+app.ts`'s `pages`, not tabs.

## Tabs break the view

When a page has more than one concern, each concern is a tab — never a long page of stacked sections,
and never two model views stacked on one scroll. A tab body renders **one** thing: one view, one
`Scroll inset` of flowing content, or one `Split` of two panes.

- One concern per tab; the title is the concern's noun ("Profiles", "Contracts") and is the title of
  the view it holds — the same words, not a variant. Tabs carry icons.
- A model that exists only under one parent belongs inside that record, never a standalone
  app page. Put it in the relevant section or tab; a short inline value list needs no separate tab.
- Nested `Tabs` step down a level on their own (segmented → underline → chips) and never add padding.
- A nested strip (level 2 or deeper) of more than two tabs is **vertical** on its own: a rail on the
  left, the body on the right, a compact scroller on a phone. Two tabs stay horizontal. Pass
  `orientation` only to override.
- A record view has **one** tab row: `RecordShell` has no History tab (each field's history is its
  popover), a `RecordShell` inside another shows its body only, and a record tab whose name or title
  a page's own strip already shows is dropped — never add both.
- A tab holding a form is `keepAlive: true`, so the form keeps its state while hidden.

## Scroll inside, never the shell

The shell and tab bodies never overflow. Scrolling happens inside the view that owns rows — `Table`,
`Board`, `Matrix`, a `Scroll`. When a view is the whole region it fills it; inside flowing content it
gets a height contract:

| Context                                  | Write                                                                                   |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| view is the region (page body, tab body) | the view directly — it fills                                                            |
| view beside other content in a column    | a `Section size="fill"` (or a `size="fill"` primitive) around it, `minHeight` its floor |
| view inside a `Scroll` of other content  | `<Bound size="viewport">` around it — the height below the page chrome                  |
| board lanes                              | the board scrolls horizontally, each lane vertically — never the page                   |

A view never takes `min-h-[…]`: a `fill` box's floor is its `minHeight`.

A `Table` fills a bounded region (a flex column or a definite height) down to its own minimum and
scrolls inside its card, header sticky and footer (row range, page size, previous/next) pinned; it
never grows its parent. Rows are one line (a long value truncates, its text is the tooltip); a click
anywhere on a row opens its record (links and controls inside it keep their own click). Headers do not sort — sorting is
the toolbar popover's — and each header's menu pins, hides and moves its column; drag a header to
reorder, its edge to resize. The viewer's column layout and page size are kept per table. Its
pages are read from the server one at a time (the footer pages); each `Board` lane loads its cards
infinitely as it scrolls. Custom cell renderers, relation cells and paging:
[controller-surfaces.md](controller-surfaces.md#7-one-kind-strategy-on-every-view).

## Representation hierarchy

Keep record identity and the primary operation in `RecordShell`. For ordinary data entry, the
default suggestion is a compact, polished, accessible form with meaningful groups and progressive disclosure.
Distinct record views can use tabs; a short, single-concern record can be a flat field grid.
Choose a step flow, widget or interactive editor when it makes the task clearer. These are UI
choices, while the shared controller's admitted writes, draft lifecycle and accessibility remain
the contract.

When disclosure helps, use the kit's behaviour rather than a custom accordion. Give each section
a stable `name`, a short translated title, and a compact grid. Secondary sections start closed with a
meaningful summary; required task inputs stay discoverable. Do not nest accordions or repeat the
record heading in a tab body. Preserve mounted form fields across tabs, validation, and submission.
Use the same spacing, typography and field ordering in create, edit and read views.

Keep headings short and help behind the existing info affordance. Do not repeat a field label in
its help, repeat the record summary in each tab, or expose technical configuration the person
cannot act on. Disclosure hides secondary detail without losing required choices, validation or
operations. Inspect the real empty, long-content and narrow states for overlapping labels,
controls and field values; compilation cannot prove those layouts.

Forms, grids and model views fill their available pane; do not impose a narrow measure on
the whole representation. Short controls use responsive `Grid minimum="compact"` or `"card"`
to share a row when space permits. Give long text, complex custom editors and wide data surfaces
`Column span="all"` or their own full-width section. Keep prose at a readable measure, and let
phone layouts wrap naturally without horizontal overflow.

## Form layout defaults

`Form of="<c>" mode="create" | "update"` edits a model's allowlisted fields. Business-operation
buttons start named automations with explicit typed input. Start with a compact `Grid`. Add a `Section` for a meaningful
group of attributes, inline management of a related model, or a genuinely complex attribute.
Group by the user's task or domain, not field kind or database order. A simple field such as
Authority belongs with Identity or General rather than in a section of its own. A complex editor
can justify a section even when it represents one attribute.

For example, terms form one group while a document list can be secondary disclosure:

```svelte
<Form of="loans" mode="update" id={loan.id}>
	<Section first title={bolt.t('loan.section.terms')} hint={bolt.t('loan.section.terms_hint')}>
		<Grid minimum="card">
			<Field name="principal" />
			<Field name="instalment" />
		</Grid>
	</Section>
	<Section
		name="documents"
		title={bolt.t('loan.section.documents')}
		defaultOpen={false}
		summary={bolt.t('loan.files', { n: loan.documents.length })}
	>
		<Field name="documents" />
	</Section>
</Form>
```

`Section` (from `@norbital-ai/ui`), all props optional but `children`:

| Prop                  | Default   | Meaning                                                                                              |
| --------------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `title`               | —         | the heading; untitled, the section is plain content, always open                                     |
| `hint`                | —         | one sentence behind an ⓘ beside the title                                                            |
| `name`                | `title`   | the stable key the viewer's open state is remembered under (set it: titles change with the locale)   |
| `first`               | `false`   | no rule above (the first section of a body)                                                          |
| `collapsible`         | `true`    | `false` keeps a titled section always open, no toggle                                                |
| `defaultOpen`         | `true`    | `false` marks a secondary section: closed until the viewer opens it                                  |
| `summary`             | —         | a string or snippet beside the title while closed ("3 files", "2 overridden", "Not set")             |
| `trailing`, `actions` | —         | a mark (badge) after the title; controls at the end of the heading row                               |
| `size`                | `content` | `fill` shares the column's height left and scrolls inside itself ([layout](layout-and-scrolling.md)) |
| `minHeight`           | —         | a `fill` section's floor (a CSS length; default its content or 16rem, whichever is less)             |

The whole heading is one button (`aria-expanded`, `aria-controls`, Enter/Space). A collapsed body is
hidden, never unmounted, so its fields still validate and save. The viewer's choice is kept in
`localStorage` per model and `name`; a section holding a field with an error opens itself.
Which sections start closed is the template's judgement: [ui-standard](ui-standard.md) rule 16.

### Generated record views take `sections`

A record with no `+representation.svelte` and no body gets `RecordShell`'s generated view (read,
edit and create). Where grouping is useful, supply it declaratively with `sections` on
`RecordShell`, or on a generated `Form` (no `children`):

```svelte
<RecordShell
	of="customers"
	{id}
	sections={[
		{
			name: 'contact',
			title: bolt.t('customer.section.contact'),
			fields: ['name', 'phone', 'email']
		},
		{
			name: 'billing',
			title: bolt.t('customer.section.billing'),
			fields: ['billing_address', 'tax_id'],
			defaultOpen: false,
			summary: (row) => (row.tax_id ? String(row.tax_id) : bolt.t('common.not_set'))
		}
	]}
/>
```

`RecordShell` props for its generated view:

| Prop       | Meaning                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| `fields`   | create: offered beyond `values`' keys; update: only these, in this order                                                   |
| `sections` | `readonly { name, title?, hint?, fields, defaultOpen?, summary? }[]` — each a `Section` holding its `fields` in that order |

Each entry is a `Section` with the same behaviour: `name` is the remembered-state key, `title` and
`summary` arrive translated, `summary` is a string or `(row) => string` (the shown row; the draft
while editing). Fields no section lists follow in one untitled, always-open group, so nothing
disappears; a name the model does not have is ignored with a console warning. One-relation
keys may be listed too. Without `sections` the view is the flat field grid.

Use tabs when the form has distinct tasks or views, not just because it is long. Form tabs use
`keepAlive` so every field stays mounted for validation and submit. A field never appears in two
sections. Repeated values use one clear add/edit path; do not duplicate controls already supplied
by their editor. Let people edit source inputs, and present derived results as readonly information
when useful rather than capturing the same fact independently.

### Prefill known context

A create opened from its parent carries that relation in `values`. Keep it in the submitted
payload and hide the redundant parent picker only when the value is present. Standalone creation
still offers the picker; a missing or null prefill never hides a required input. Prefer declared
model defaults for ordinary initial values, keeping those choices editable. Custom create flows
must also honour supplied values rather than starting their controls empty.

Disclosure only changes visibility: keep every field, operation and permission rule available.
Collapsed inputs stay mounted, validate and save; form tabs use `keepAlive`. A computed or fixed
value can be readonly when the person needs to inspect it. Never hide an unresolved required
choice or remove an operation to make the page look simpler.

### Readonly is not disabled

| Mode       | Looks like                                                                                                                                                                                                     | Use for                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `readonly` | no field chrome: a label over the value as text, formatted by its kind (refs by the related row's label, enums by label, booleans Yes/No, empty `—`), selectable, with a copy button on hover/focus; no submit | a record the viewer may see but not change (an employee's own contract) |
| `disabled` | the editor stays, muted, unfocusable, `not-allowed` cursor; submit disabled                                                                                                                                    | a field that is editable in principle but not right now                 |

Set the mode once; it reaches every control beneath through context. A `Field` or `Fieldset` may
override it; `Fieldset readonly | disabled legend?` groups part of a form.

```svelte
<Form of="loans" mode="update" id={loan.id} readonly={loan.status === 'closed'}>
	<Field name="principal" />
	<Fieldset disabled={!canReschedule}><Field name="instalment" /></Fieldset>
</Form>
```

Use the shared record controller for view, edit and create. Readable fields remain visible while
the controller offers only admitted changes; state, approval, source-ownership and parent locks
provide restriction reasons. A self-service page uses the normal form and native capabilities,
never `readonly={!admin}` or a parallel policy matcher. The backend remains authoritative and
rechecks every submitted operation. Do not treat the presence of an update contract as permission.
A readonly `Field` renders its kind, not its `editor` snippet; a custom field shows its renderer's
`mode: 'show'`, where the kit's `Input`/`Combobox`/`Checkbox`/`Picker` already render as text (read
`useControls()` for anything else). A `Form` never inherits an outer mode.

### Inline related information

Use the shipped structured-value and matrix renderers for related information that people manage
in context. The parent's declared write layers (`create.columns` / `update.columns` paths) determine
which real-child create, update, delete, link and unlink operations are accepted. A filtered or partially loaded list is not the complete
relationship: preserve unseen children and submit only explicit operations. Child writes carry
their IDs and observed revisions. An independently edited child uses its own admitted save; an
owned child follows the parent lock. Open the full child representation when the task requires it.
Do not duplicate its fields in a second custom editor or invent permission logic in the page.

### Useful charts only

Add a chart only after naming the decision it supports, its scope, units and time range. If a
table, status, total or query answers the question clearly, use that simpler surface. Query and
aggregate the appropriate scoped data; do not load a capped page and label it as a complete total.
Avoid decorative charts, repeated summaries and multiple visualizations of the same fact.

## Padding and alignment

- Content aligns with the hero's leading edge: the app inset, applied once by the region's
  scrollport. You never write padding for the page edge.
- Space between things is the parent's `gap`; space inside a boundary is that boundary's own
  padding. No margins.
- Nothing is centred in a wide region unless it is a single card, form, or empty state
  (`Center measure="narrow"` or `Cover center`).
