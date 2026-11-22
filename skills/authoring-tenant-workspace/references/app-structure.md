# App structure

Where things go on a page (one home per concern). Exact props: `workspace_lang`. Layout mechanics: [layout-and-scrolling.md](layout-and-scrolling.md).

## Slots & toolbar

A model page is its view — no heading card, paragraph or button row above it.

| Thing | Home |
| --- | --- |
| App identity | `AppShell` props (rendered once in hero) |
| Page-wide scope (company, site, period) | `AppShell` `actions` snippet (one picker set every tab reads; carry scope status inside `Combobox` `badge`, not beside it) |
| View-local display control | `toolbar.controls` (never scope; never view/sub-report switching) |
| Page-level operation | `toolbar.actions` (⚡ menu) |
| Row / record operation | view row `actions` / `RecordShell` `actions` (one primary `Button variant="brand"` directly visible, rest in overflow) |
| Create / filter / paging | `toolbar.new` (`RecordShell mode="create"`) / toolbar popover (`where` fixed, `initial_filter` default) / table footer |

- Toolbar is one row: 1–3 word title, ⓘ `description`, widgets flush left, New alone flush right. Never put buttons above/beside a view or hand-roll search, `<select>` or action bars.
- Phone hero collapses to one line (title, info button, `actions` popover — stay mounted while closed).

## The ⚡ menu & mutations

- Lists Sync now (`capabilities.syncs`), file sync Import/Export/Template, and Delete selected automatically via native `bolt.sync_control(model, sync, input)` (syncs are never automations).
- Standalone buttons execute through component-level `const save = use_act(ctx)` and `onclick={() => save.run(ctx.run('name', input))}` (creating an Effect without running it writes nothing). Custom record-header actions pass outcomes to `notify_outcome`.
- `toolbar.actions` items (`icon`, `name`, `description?`, `run(selected)`, `requires_selection?`, `disabled?`): return nothing (closes menu), an Effect (spinner → Done / inline+toast failure), `bolt.act` (toasts committed/`pending_approval`), or `ctx.run` (live `RunStatus` under toolbar). Never manage spinners/toasts manually. Pass `toolbar.context` for file sync scope.
- `CustomView` over a model inherits its file syncs, title and New. Never loop download clicks; heavy exports belong in a file sync.

## AppShell, tabs & tables

- `AppShell`: `variant="page"` (default) pads one view; `variant="full"` leaves body to `Tabs` or `<Scroll inset>` (never wrap a single `<Table>` directly in `variant="full"`).
- One concern per view (app page, app tab, or record tab): at most one `Table` or `Board` per view; tab title = view title + icon; one tab size (`Tabs` / `TabStrip`, never hand-rolled `role="tab"`). Nested `Tabs` step down automatically (level 1 default, 2 underline, 3 chips; >2 deep go vertical left). Use `keep_alive: true` on form tabs.
- One compact control size (`Button`: `default`, `icon`, `lg` only for lone non-form CTA). Size controls from parent layout — never fixed `w-*`/`h-*` on inputs/controls.
- Model tables read displayed fields, labels and currency deps (opening a record reads full view; custom `cell`/row actions keep light row contract). Rows are one line; click opens record (or `on_open`); headers pin/hide/move (no sort). `Board` lanes load infinitely.

## Representations, forms & disclosure

- Keep identity and primary action in `RecordShell` (always owns visible header/footer and scrolling body — decorate via `footer`/`footer_actions`, never add a second footer). One tab row per record; no duplicate History tab.
- Group fields by task into compact multi-column `Grid`s (2–3 short fields/row) inside meaningful `Section`s with stable `name` and consistent Lucide `icon` (≥2 controls or 1 large control; never repeat a field across sections; collapse optional notes with `default_open={false}` + `summary` without hiding required choices). Never nest accordions. Keep field order consistent across create/edit/read.
- One view, one Save (footer submits via shared controller; settings/singletons use `RecordShell` too, no bare page-level `Form`). Pass parent FK in `values` on create; hide parent picker only when non-null.
- **Readonly vs disabled:** `readonly` (no chrome, copy-on-hover text) = viewer cannot edit; `disabled` (muted editor) = temporarily unavailable. Set once on the shared record controller — never `readonly={!admin}`. Readonly `Field` renders its kind, not `editor`.
- Inline children use `ChildGrid`/structured renderers preserving unloaded children with IDs + revisions; owned children follow parent lock.

## Charts & run feedback

- `<Chart {ctx} of="<model>" x="<field>" y="count|sum.f|avg.f" where={…} />`: every chart answers a stated decision with scoped aggregates (never capped pages). Give charts a bounded panel height (`~16–20rem`), never `<Bound size="viewport">`.
- Track jobs via native `RunStatus` and record `RunsFor`; long jobs report `ctx.progress({ text, ratio? })` in the record body/footer.
