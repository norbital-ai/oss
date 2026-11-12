# What Bolt already renders

Read before writing a page. When a page seems to need one of these, configure the built-in: a model declaration, toolbar key or column option. Exact props: query the component's type.

## Page shape

1. `AppShell` with hero props; scope pickers in `actions`.
2. One view of the subject: discover the view components with `keyof typeof import('@norbital-ai/ui')`; `CustomView` for any other body, with the same toolbar. Scope with `where`.
3. Operations in their slots: [app-structure.md](app-structure.md).
4. Each view makes one `ctx.query` (or `of=` a model) with its layers.

## Table and toolbar

| Built in | How you get it |
| --- | --- |
| Search | a text entry under `indexes`; `record_label` is indexed automatically |
| Filter and sort | default; fixed scope `where`, starting filter `initial_filter` |
| Column menu | always |
| Export CSV | `toolbar.export`; a file sync replaces it |
| ⚡ Import, template, Export, Sync now, Update and Delete selected | the model's syncs and grants |
| Page operations | `toolbar.actions` |
| New | a `create` grant |
| Row open | the record sheet (`?record=<model>/<id>`) unless `on_open` |
| Selection, select all, cursor paging, footer, empty states, approval accents | always |
| Cell rendering | by kind; a link shows the linked label as text, the row opens the record; `cell` only for computed display |

## Record sheet and forms

- `RecordShell` renders the representation with the state pill, lock banner, approval panel (approve, reject, request changes, Resubmit), history with restore, and runs.
- Grants, state edges, `transitions` and named model `constraints` are enforced and shown. Forms use the engine's verdict.
- A field without a grant is readonly. A representation edits the record's own facts: identity it cannot change goes in the header or is left out.

## Kinds render themselves

- Text formats, money, numbers, dates, periods, enum and state words, files, points, links and typed json render and edit themselves in cells, forms, boards and history.
- Enum and state words come from `models.<m>.fields.<f>.<value>`; use `enum_text` or `use_enum_text` to compose. Never write a label map.
- A new value type is a custom field, used everywhere automatically.

## The shell

Never build: the approval inbox, notifications, Settings (people, organisation, audit, automation runs, integrations, secrets), the finder (⌘/), Studio, kiosk and device walls (`+app.ts` `requires`). The generic integration setup covers pairing, test, reconnect and disconnect.
