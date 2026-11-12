# App structure

Where things go on a page. Each kind of thing has one home. Exact props: query the exported component's type. Layout mechanics: [layout-and-scrolling.md](layout-and-scrolling.md).

## Slots

A page whose subject is a model is that view: no heading card, paragraph or button row above it.

| Thing | Home |
| --- | --- |
| App identity | `AppShell` props; the hero renders them once |
| Page scope (company, site, period) | `AppShell` `actions` snippet: one set of pickers every view reads. A status the chosen scope carries goes inside its picker (`Combobox` `badge`), not beside it. On a phone the hero is one line: the title, its description behind an info button, `actions` behind one button in a popover |
| View-local presentation control | `toolbar.controls`, never scope |
| Page-level operation | `toolbar.actions`, the ⚡ menu |
| One-row operation | the view's row `actions`: an automation or guarded verb |
| One-record operation | `RecordShell` `actions` |
| A run's progress | an item whose `run` returns `ctx.run(…)`; `RunStatus` or `RunsFor` elsewhere |
| Create | `toolbar.new`, which opens `RecordShell mode="create"` |
| Filter and sort | the toolbar popover; fixed scope is `where`, a starting filter `initial_filter` |
| Row range and paging | the table's footer |

- The toolbar is one row: title (1 to 3 words), ⓘ `description`, then widgets flush left; New alone flush right and last when wrapped. A slot never moves.
- No button sits in the header, above or beside a view. A hand-made run button, search box, `<select>` or action bar is a second spelling of a slot.
- The header's `actions` holds scope pickers only. Placing a picker does not authorize data.
- A status the chosen scope carries goes inside its picker (`Combobox` `badge`), not beside it.
- On a phone the hero is one line: title, description behind an info button, `actions` behind one button that opens them in a popover. They stay mounted while it is shut.

## The ⚡ menu

- It lists Sync now, each file sync's Import, Export and Download template, and Delete selected, with no page wiring. The native `bolt.sync_control(model, sync, input)` operation owns refresh and file transfer; syncs are never automation callables or schedule targets. Remote refresh requires `capabilities.syncs: ['model.sync_name']`; file transfer uses the caller's model grants.
- A `toolbar.actions` item is `icon`, `name`, optional `description` and `run(selected)`. The menu derives the row's state from what `run` returns:

| `run` returns | Row |
| --- | --- |
| nothing | closes the menu |
| an Effect | spinner, then Done; a typed failure shows in place and as a toast |
| an Effect from `bolt.act` | its committed or pending-approval result is toasted; refusals use the failure channel |
| an Effect from `ctx.run` | the run's live status under the toolbar |

- `requires_selection: true` lists it under Bulk and turns selection on. `disabled: (selected) => string | null` says why not.
- Never toast or track a spinner for a menu item yourself.
- `toolbar.context` is what the view is scoped to; file syncs receive it.
- A `CustomView` over one model names its model source: its menu offers that model's file syncs, title and New; search runs over its own rows.
- Client-generated text documents go through `download_text_files`: one downloads, several zip. Never loop download clicks. Build documents with a pure helper; an export too heavy for the page is a file sync.
- A custom record-header action passes its typed outcome to `notify_outcome`.

## AppShell and tabs

- Every page is an `AppShell`. `variant="page"` (default) pads for one view; `variant="full"` leaves the body to `Tabs` or a `Scroll inset`. A heading never repeats the hero.
- One concern per tab, never stacked sections or two model views on one scroll. A tab body renders one view, one `Scroll inset`, or one `Split`.
- A tab's title is its view's title, with an icon.
- A model existing only under one parent lives in that record, never a standalone page.
- Nested `Tabs` step down a level on their own and add no padding; a nested strip of more than two tabs goes vertical on its own.
- One tab size: use `Tabs`, or `TabStrip` without bodies. Never hand-roll `role="tab"` or restyle a tab.
- One control size: inputs, pickers, date fields and form buttons are compact. `Button` has `default`, `icon`, and `lg` only for a lone call to action outside forms. Pass a width through `class`, never height, padding or font.
- A record view has one tab row: `RecordShell` has no History tab; a shell nested in another shows its body only; a tab a page's strip already shows is dropped.
- A tab holding a form is `keep_alive: true`.

## Table behaviour

Rows are one line; a click opens the record; headers do not sort; each header's menu pins, hides and moves; the viewer's layout and page size persist. Pages load from the server; `Board` lanes load infinitely.

## Representations

- Keep identity and the primary operation in `RecordShell`. Default: a compact accessible form with meaningful groups; steps or widgets when they make the task clearer. The shared controller's admitted writes and draft lifecycle stay the contract.
- Use the same spacing, typography and field order in create, edit and read.
- Do not repeat a label in help or the summary in each tab. Do not expose configuration the person cannot act on.
- Forms and views fill their pane. Short controls share a row through `Grid`; long text and complex editors span full width. Prose keeps a readable measure.

## Form layout

- `Form of mode` edits a model's allowlisted fields. Business buttons start automations with typed input.
- Start with a compact `Grid`. Add a `Section` for a meaningful group, inline related management, or one complex attribute. Group by task, not field kind or database order.
- A section groups at least two controls or one large control. A lone small field merges into its neighbour.
- A field never appears in two sections. Repeated values have one add/edit path. Show derived results as readonly.
- Tabs are for distinct tasks, not length. Never nest accordions.
- `Section`: give a stable `name` (titles change with locale); `default_open={false}` marks secondary, with a useful `summary`. A collapsed body stays mounted, validates and saves; a section with an error opens itself.
- Generated record views take `sections`; fields no section lists follow in one group, so nothing disappears. `fields` on create offers fields beyond `values`; on update it restricts and orders.

## Prefill and disclosure

- A create opened from a parent carries the relation in `values`; hide the parent picker only when the value is present. A null prefill never hides a required input.
- Prefer model defaults for initial values. Custom create flows honour supplied values.
- Disclosure changes visibility only. Never hide an unresolved required choice or remove an operation.

## Readonly is not disabled

| Mode | Looks like | Use |
| --- | --- | --- |
| `readonly` | no field chrome, value as text by kind, copy on hover | a record the viewer may see, not change |
| `disabled` | editor stays, muted, submit disabled | editable in principle, not right now |

- Set the mode once; it reaches every control. A `Field` may override. A `Form` never inherits an outer mode.
- Use the shared record controller for view, edit and create. Never `readonly={!admin}` or a parallel policy matcher. An update contract is not permission.
- A readonly `Field` renders its kind, not its `editor` snippet.

## Inline related information

- Use the shipped structured-value and matrix renderers. The parent's write layers decide accepted child operations.
- A filtered list is not the whole relation: preserve unseen children and submit explicit operations with IDs and observed revisions.
- An independently edited child uses its own save; an owned child follows the parent lock.
- Open the full child representation when needed; never duplicate its fields or permission logic.

## Charts

Name the decision, scope, units and range first. Use a table, status or total if it answers. Aggregate scoped data; never label a capped page as a total. No decorative or duplicate charts.
