# App structure

Which primitive serves which job, and where each thing goes on a page. Principles: `product-ux`. Exact props: `workspace_lang`. Layout mechanics: [layout-and-scrolling.md](layout-and-scrolling.md).

## Primitive taxonomy (one primitive, one role)

Pick the simplest native primitive that fits the data shape; add custom UI only where a primitive's contract falls short.

| Data / job | Primitive | Notes |
| --- | --- | --- |
| Collection of independent records | `Table` or `Board` | Owns the list, search, filter, sort, paging and bulk selection. |
| Collection actions and exports (reports, bulk runs, file syncs) | Toolbar `⚡` (`toolbar.actions` + native file syncs) | The one home for collection operations; never loose export or batch buttons in a representation. |
| One record: data entry or fixed structured view | `+representation.svelte` inside `RecordShell` | Lifecycle moves go in `RecordShell` `actions` / `footer_actions`. |
| Parent and owned children forming one entity | In-place matrix (`ChildGrid save="parent"`, `Rows`, or an editable matrix via `Form` `acts`) | One entity, one Save: never a nested `Table` opening child sheets, never per-row immediate `ctx.act()`. |
| Dated series, effective-dated history, change logs | `Timeline` from `@norbital-ai/ui` | The same primitive `RecordShell` History and `ApprovalPanel` use; never a generic table or a per-template layout. |

## File placement and co-location

Keep each component and service beside the one module that owns it; move it to `src/lib/` only when two or more consumers share it.

| What | Where |
| --- | --- |
| UI for one custom datatype | `src/data/custom_field/<name>/` beside `+renderer.svelte` |
| UI for one model's representation | beside that model's `+representation.svelte` |
| UI or client helpers for one page | `src/app/<app>/` beside `+<page>.page.svelte` |
| One model's services, calculations, validators, queries | beside its `+model.ts` (or `service/` under it) |
| UI shared by two or more pages, models or datatypes | `src/lib/` (a `src/lib/<feature>/` folder when multi-file) |
| Cross-model pure helpers and shared stores | `src/lib/`, never a grab-bag for one model's logic |

## Slots and toolbar

A model page is its view: no heading card, paragraph or button row above it.

| Thing | Home |
| --- | --- |
| App identity | `AppShell` props (rendered once in the hero) |
| Page-wide scope | `AppShell` `actions` (one picker set every tab reads; scope status inside `Combobox` `badge`) |
| View-local display control | `toolbar.controls` (never scope, never view switching) |
| Collection action, export, report | `toolbar.actions` (`⚡`) or a model file sync |
| Single-record lifecycle move | `RecordShell` `actions` / `footer_actions` (one primary `Button variant="brand"` visible, the rest in overflow) |
| Create, filter, paging | `toolbar.new` (`RecordShell mode="create"`), the toolbar popover (`where` fixed, `initial_filter` default), the table footer |

- The toolbar is one row: a 1–3 word title in plain words, ⓘ `description` explaining the view, widgets flush left, icon-only switchers between alternate views of the same collection in `toolbar.trailing` beside `+ New`, `+ New` flush right. Never hand-roll search, `<select>` or action bars.
- Phone hero collapses to one line (title, info button, `actions` popover that stays mounted while closed).

## The ⚡ menu and mutations

- `⚡` holds every collection-level action: Sync now (`capabilities.syncs`), file sync Import/Export/Template, bulk Delete, and author `toolbar.actions`.
- Standalone buttons run through `const save = use_act(ctx)` and `onclick={() => save.run(ctx.run('name', input))}` (an Effect not run writes nothing). Custom record-header actions pass outcomes to `notify_outcome`.
- `toolbar.actions` items (`icon`, `name`, `description?`, `run(selected)`, `requires_selection?`, `disabled?`) return nothing (closes the menu), an Effect (spinner, then Done or inline + toast failure), `bolt.act` (toasts committed / `pending_approval`) or `ctx.run` (live `RunStatus` under the toolbar). Never manage spinners or toasts by hand. Pass `toolbar.context` for file sync scope.
- `CustomView` over a model inherits its file syncs, title and New. Never loop download clicks; heavy exports belong in a file sync.

## AppShell, tabs and tables

- `AppShell`: `variant="page"` (default) pads one view; `variant="full"` leaves the body to `Tabs` or `<Scroll inset>` (never a single `<Table>` directly in `full`).
- One concern per view (app page, app tab or record tab): at most one `Table` or `Board`; tab title = view title + icon; `Tabs` / `TabStrip`, never hand-rolled `role="tab"`. Nested `Tabs` step down automatically (level 1 default, 2 underline, 3 chips; deeper go vertical left). `keep_alive: true` on tabs holding forms or heavy client viewers.
- One compact control size (`Button` `default`, `icon`; `lg` only for a lone non-form CTA). Size controls from the parent layout, never fixed `w-*`/`h-*`.
- Model tables read displayed fields, labels and currency dependencies (opening a record reads the full view; custom cells and row actions keep the light row contract). Rows are one line; headers pin, hide and move (no sort). `Board` lanes load infinitely: pass static `lanes` when the values are known, keep cards to 1–2 lines (`card` snippet), `select={false}` when a `Table` already owns bulk selection, no page-level `ctx.query` repeating its scope.

## Rows and linked views

- A row click opens that row's record by default. Cells hold no links or buttons; per-row operations are `actions`.
- A list paired with a picture of the same records shares one selection (`product-ux`): `on_open` selects (selecting the selected row clears), `row_class` marks the selected row, `actions` carries Open. The picture takes the selection as a prop, shows only that record and frames it, and reports a clear through a callback so the list's selection follows. A row with nothing to show in the picture opens normally.

## Record hub and forms

- `RecordShell` owns the header, footer and scrolling body; decorate it through `footer` / `footer_actions`, never a second footer. One tab row per record; no duplicate History tab.
- Tabs partition the record's concerns (`product-ux`). The shell's body (the record's own tab) is an update `Form` holding identity and the fields no other tab owns. A field another tab owns renders in that tab inside its own update `Form` with `id={record.id}`; every such form shares the shell's draft and one Save. Create shows the fields needed to start the record, grouped by the same sections.
- Group fields by task into compact multi-column `Grid`s (2–3 short fields per row) inside `Section`s with a stable `name` and a Lucide `icon` (two or more controls, or one large one). Never repeat a field across sections or tabs; collapse optional groups with `default_open={false}` + `summary` without hiding required choices; never nest accordions. Keep field order the same across create, edit and read.
- One view, one Save: settings and singletons use `RecordShell` too, never a bare page-level `Form`. Pass the parent ref in `values` on create.
- Once a model has a `+representation.svelte`, it owns field visibility. Hide the parent ref the view is scoped to (stored records and scoped creates); show a parent picker only on an unscoped standalone create, or name the parent in `subtitle` when opened out of context. Omit internal counters the view already shows as records. Lock (`disabled` / `readonly`) keys fixed by the context that opened the view, and scope every dependent `<Picker>` with `where` to the resolved parent.
- **Readonly vs disabled:** `readonly` (plain copyable text) = the viewer cannot edit; `disabled` (muted editor) = temporarily unavailable. Set it once on the shared record controller.
- Server-derived fields (written by a `transform`) stay out of `create.fields` / `update.fields` and show read-only only when non-empty. Never expose a mirror of a catalogue pick separately. Give structured values domain pickers (`TimeInput`, `TimeRangeInput`, schema-backed controls), never generic array or object chrome.

## Charts and run feedback

- `<Chart {ctx} of="<model>" x="<field>" y="count|sum.f|avg.f" where={…} />`: every chart answers a stated decision with scoped aggregates (never capped pages), in a bounded panel (~16–20rem), never `<Bound size="viewport">`; same-unit series share one multi-series chart. A chart sits in the tab of the concern it measures.
- Track jobs with `RunStatus` and record `RunsFor`; long jobs report `ctx.progress({ text, ratio? })`.
