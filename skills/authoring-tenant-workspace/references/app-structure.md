# App structure

Where things go on a page (one home per concern). Exact props: `workspace_lang`. Layout mechanics: [layout-and-scrolling.md](layout-and-scrolling.md).

## Primitive taxonomy (one primitive, one role)

Pick the simplest native primitive that fits the data shape; only add custom UI when a primitive's contract falls short.

| Data / job                                                    | Primitive                                                                                               | Notes                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection / list of independent records                      | `Table` or `Board` (Kanban)                                                                             | Houses the list, search, filter, sort, paging, and bulk selection.                                                                                                                                                                                                                                               |
| Collection actions & exports (reports, bulk runs, file syncs) | Toolbar `⚡` (`toolbar.actions` + native file syncs)                                                    | Single home for collection operations and exports. Never place export or batch-action buttons loose inside a record's `+representation.svelte`. When none are needed, fall back to the default primitive chrome.                                                                                                 |
| Single-record data collection / fixed structured view         | `+representation.svelte` inside `RecordShell`                                                           | For creating/editing one record or showing it in a fixed structured layout that also doubles as data collection. Single-record lifecycle moves (e.g. Mark paid, Publish) go in `RecordShell` `footer_actions`/`actions`.                                                                                         |
| Parent + owned children treated as **one entity**             | In-place data matrix (`ChildGrid save="parent"`, `Rows`, or embedded editable matrix via `Form` `acts`) | **One entity = one atomic Save operation.** Never mount a nested standalone `<Table>` (opening separate child sheets) or fire immediate per-row `ctx.act()` calls when parent and children form one logical entity (e.g. loan + repayments, order + lines, trial + components).                                  |
| Time-series, effective-dated history & change logs            | Shared `Timeline` from `@norbital-ai/ui`                                                                | For dated contract/terms history, change logs, revision/approval trails and chronological activity streams — never generic tables. Reuse the single `@norbital-ai/ui` `Timeline` primitive (also used by `RecordShell`'s History widget and `ApprovalPanel`) rather than inventing one-off per-template layouts. |

## Slots & toolbar

A model page is its view — no heading card, paragraph or button row above it.

| Thing                                   | Home                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| App identity                            | `AppShell` props (rendered once in hero)                                                                                                   |
| Page-wide scope (company, site, period) | `AppShell` `actions` snippet (one picker set every tab reads; carry scope status inside `Combobox` `badge`, not beside it)                 |
| View-local display control              | `toolbar.controls` (never scope; never view/sub-report switching)                                                                          |
| Collection action / export / report     | `toolbar.actions` (`⚡` menu) or model file sync                                                                                           |
| Single-record lifecycle move            | view row `actions` / `RecordShell` `actions` or `footer_actions` (one primary `Button variant="brand"` directly visible, rest in overflow) |
| Create / filter / paging                | `toolbar.new` (`RecordShell mode="create"`) / toolbar popover (`where` fixed, `initial_filter` default) / table footer                     |

- Toolbar is one row: 1–3 word title, ⓘ `description`, widgets flush left, New alone flush right. Never put buttons above/beside a view or hand-roll search, `<select>` or action bars.
- Phone hero collapses to one line (title, info button, `actions` popover — stay mounted while closed).

## The ⚡ menu & mutations

- The `⚡` icon is the unified trigger for collection-level actions and exports: Sync now (`capabilities.syncs`), file sync Import/Export/Template, bulk Delete, and author `toolbar.actions` (custom exports, batch automations). Never duplicate those export buttons inside `+representation.svelte`.
- Standalone buttons execute through component-level `const save = use_act(ctx)` and `onclick={() => save.run(ctx.run('name', input))}` (creating an Effect without running it writes nothing). Custom record-header actions pass outcomes to `notify_outcome`.
- `toolbar.actions` items (`icon`, `name`, `description?`, `run(selected)`, `requires_selection?`, `disabled?`): return nothing (closes menu), an Effect (spinner → Done / inline+toast failure), `bolt.act` (toasts committed/`pending_approval`), or `ctx.run` (live `RunStatus` under toolbar). Never manage spinners/toasts manually. Pass `toolbar.context` for file sync scope.
- `CustomView` over a model inherits its file syncs, title and New. Never loop download clicks; heavy exports belong in a file sync.

## AppShell, tabs & tables

- `AppShell`: `variant="page"` (default) pads one view; `variant="full"` leaves body to `Tabs` or `<Scroll inset>` (never wrap a single `<Table>` directly in `variant="full"`).
- One concern per view (app page, app tab, or record tab): at most one `Table` or `Board` per view; tab title = view title + icon; one tab size (`Tabs` / `TabStrip`, never hand-rolled `role="tab"`). Nested `Tabs` step down automatically (level 1 default, 2 underline, 3 chips; >2 deep go vertical left). Use `keep_alive: true` on form tabs.
- One compact control size (`Button`: `default`, `icon`, `lg` only for lone non-form CTA). Size controls from parent layout — never fixed `w-*`/`h-*` on inputs/controls.
- Model tables read displayed fields, labels and currency deps (opening a record reads full view; custom `cell`/row actions keep light row contract). Rows are one line; click opens record (or `on_open`); headers pin/hide/move (no sort). `Board` lanes load infinitely; pass static `lanes` whenever the lane values are known so lanes and counts load in parallel, and avoid duplicating a `Board`'s scope in redundant page-level `ctx.query` waterfalls.

## Representations, forms & disclosure

- Keep identity and primary action in `RecordShell` (always owns visible header/footer and scrolling body — decorate via `footer`/`footer_actions`, never add a second footer). One tab row per record; no duplicate History tab.
- Group fields by task into compact multi-column `Grid`s (2–3 short fields/row) inside meaningful `Section`s with stable `name` and consistent Lucide `icon` (≥2 controls or 1 large control; never repeat a field across sections; collapse optional notes with `default_open={false}` + `summary` without hiding required choices). Never nest accordions. Keep field order consistent across create/edit/read.
- One view, one Save (footer submits via shared controller; settings/singletons use `RecordShell` too, no bare page-level `Form`). Pass parent FK in `values` on create. `RecordShell`'s `fields` prop applies only to the generated view — once a model has `+representation.svelte`, that representation owns field visibility: **always hide innately scoped parent FKs** (`project_id`, `entity_id`, `machine_id`, `raw_material_id`, etc.) on stored records (`record !== null`) and scoped creates (`view.values.<fk> != null`) because the parent is already part of the representation's scope (show the parent picker only on a truly unscoped standalone create, or surface parent identity in `RecordShell` `subtitle` when opened out of context). Omit redundant internal sequence numbers or counters (`submission_no`, `trial_count`) when the view already displays the records directly. Lock (`disabled`/`readonly`) context-fixed keys from a clicked cell (`employment_id`, `work_date`) while showing any read-only projected context, and scope every dependent relation `<Picker>` with `where` to the resolved parent (never a bare unscoped `<Field>` for an entity-owned ref).
- **Readonly vs disabled:** `readonly` (no chrome, copy-on-hover text) = viewer cannot edit; `disabled` (muted editor) = temporarily unavailable. Set once on the shared record controller — never `readonly={!admin}`. Readonly `Field` renders its kind, not `editor`.
- **No server-derived or raw-JSON domain editors:** keep `transform`-computed fields (e.g. `findings`) out of `create.fields`/`update.fields` (transforms write any column) and show them read-only only when non-empty. Never expose mirror/duplicate codes separately when derived from a catalogue pick. Give domain structured values (time/instant intervals, schema-driven inputs) dedicated pickers (`TimeInput`/`TimeRangeInput` or schema-backed controls) rather than generic `Empty array` / `Additional properties` chrome, and keep rare optional exception objects collapsed/opt-in.
- **One entity vs independent children:** whenever designing inputs for a relationship, first decide whether parent + children are **one logical entity** (aggregate). If yes (e.g. loan + repayment schedule, order + lines, trial + components), edit children **in place** via a data matrix (`ChildGrid save="parent"` — auto-rendered by `RecordShell` when the parent declares nested child layers — or `Rows` / embedded matrix wired to `form.queue_children` on create and `Form` `acts` on update) with **create/update parity** (never downgrade create to a hidden or read-only preview) so parent and children commit together in **one Save operation** (preserving unloaded children with IDs + revisions, owned children following parent lock). Reserve nested `<Table>` tabs strictly for independent child collections with their own lifecycle or high volume (e.g. a payroll run's payslips, a company's orders).

## Charts & run feedback

- `<Chart {ctx} of="<model>" x="<field>" y="count|sum.f|avg.f" where={…} />`: every chart answers a stated decision with scoped aggregates (never capped pages). Give charts a bounded panel height (`~16–20rem`), never `<Bound size="viewport">`.
- Track jobs via native `RunStatus` and record `RunsFor`; long jobs report `ctx.progress({ text, ratio? })` in the record body/footer.
