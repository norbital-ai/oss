# What Bolt already renders

Read this before writing any page. Everything below comes with the platform; a template that rebuilds
one of them ships a second, drifting spelling of the same control. When a page seems to need
something on this list, configure the built-in (a model declaration, a toolbar key, a column
option) instead of writing UI. Exact props: `bolt docs` (`ui`, `ui/layout`) or the installed
declarations.

## Every page has the same shape

1. `AppShell` with `icon`, `title` and `description`, which render the hero once. The page **scope**
   pickers (company or entity, site, period or month) go in its `actions` snippet. That is one set
   of pickers in the header, and every view and tab on the page reads them.
2. One view of the page's subject: `Table`, `Board`, `Map`, `Pivot`, `Matrix`, `EventCalendar` or
   `Chart`. Use `CustomView` for any other body. Scope the view with `where` from the page scope.
   The toolbar `title` is 1–3 words; what the view is for goes in its ⓘ `description`.
3. Operations go in fixed places:
   - Page-wide: `toolbar.actions`.
   - One row: the view's row `actions`.
   - One record: the record sheet's `RecordShell` `actions`.
4. A page never has:
   - A heading that repeats the hero.
   - A paragraph or button row above a view.
   - A scope picker inside a toolbar.
   - A search, filter, sort, paging, export or empty state you built yourself.
5. Each view makes one `bolt.query` (or `of=` a model) with its layers. Never read per row, and never
   fetch in an `$effect`.

## Table and the toolbar

| Built in                                                                                                           | How you get it                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Search box                                                                                                         | Declare `search.text` on the model: own text, enum and patterned `seq` fields, plus links (see below). Without it, the label's text fields are matched. |
| Filter and sort popover                                                                                            | On by default. The author's fixed scope is `where`; a starting filter the viewer can clear is `initialFilter`.                     |
| Column menu (pin, hide, move, width, saved per viewer)                                                             | Always there.                                                                                                                      |
| Export CSV                                                                                                         | `toolbar.export`. A `with: 'file'` sync replaces it.                                                                               |
| ⚡ menu: Import, Download template, Export (file syncs), Sync now, Update selected, Delete selected                 | The model's syncs and grants.                                                                                                      |
| Page operations                                                                                                    | `toolbar.actions`: `{ icon, name, description?, run, requiresSelection?, disabled? }`. The menu shows the spinner, outcome toast and run status. |
| New button                                                                                                         | A `create` grant. It opens the record sheet with the page's context.                                                               |
| Row open                                                                                                           | Opens the record sheet (`?record=<model>/<id>`) unless you pass `onOpen`.                                                          |
| Selection, "select all matching", cursor paging, row-range footer, empty states, approval accents                  | Always there.                                                                                                                      |
| Cell rendering                                                                                                     | By field kind. A link column shows the linked row's label. Use a `cell` snippet only for a value computed for display.             |

`toolbar.controls` holds a view-local presentation control, such as a grouping toggle. Scope is never one of them.

## Search across a link

A ref field in `search.text` finds the row by the linked record's own `search.text`. For example,
an entry is found by its employee's number or name:

```ts
// employment_contract: search: { text: ['employee_number', 'employee_id'] }
// claim_catalog_entry: search: { text: ['label', 'employment_id'] }
```

The toolbar search and the finder (⌘/) then cover the link with no page code. `bolt check`
refuses a link to a model that declares no `search.text`.

## Record sheet and forms

`RecordShell` renders the model's `+representation.svelte`. It provides:

- The state pill and the lock banner.
- The approval panel: approve, reject, request changes, and Resubmit.
- History with restore, and runs.

The following are enforced and shown for you; never re-check them in a form:

- Grants, state edges and enum `transitions`.
- `locked`, `check` and `noOverlap`.

A field without a grant is readonly. `readonly` shows a value as text; `disabled` keeps the editor visible but inert. A
representation edits the record's own facts: identity the record cannot change (its parent, its
company) is shown in the sheet header or left out, never as an edit field.

## Field kinds render themselves

Text formats, money, numbers, dates, periods, enum and state words, files, points, links and typed json
each render and edit themselves in cells, forms, boards and history. Files get previews. Points get a
map. Links get a picker of readable rows.

- Enum and state words come from `models.<m>.fields.<f>.<value>`. Use `enumText` / `useEnumText` when
  you compose text. Never write a label map.
- A new value type is a custom field (`data/custom_field/<name>/+definition.ts` with an optional
  `+renderer.svelte`). It is used everywhere automatically.

## The shell

Each of these already exists in the shell, so a template never builds one:

- The inbox (approvals).
- Notifications (a model's `notify`).
- Settings: people, organisation, audit, automation runs, integrations, secrets.
- The finder (⌘/).
- Studio, kiosks, and the device wall (`+app.ts` `requires`).

The generic integration setup renders pairing, test, reconnect and disconnect. Write
`+integration.svelte` only when setup truly differs.
