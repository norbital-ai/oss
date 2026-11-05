# Controller surfaces

How apps and forms show multi-entity, effective-dated data without leaking system identifiers.

## Authoring

- Keep file count small. Inline lookups, pickers and miss-to-`—` expressions in the page. Do not create one-function helpers, option modules or thin picker wrappers.
- Extract a `.svelte` only for a real component with structure, interaction and reuse.
- `$state` holds input; `$derived` captures it in `bolt.query` and derives ids, labels and charts. Check `current`, `error`, `loading` before choosing empty, denied or pending. No `$effect` or watch to recreate reads.
- Every painted value answers an operator question. No raw keys or debug ids. Show `—` for an unresolved label. `code · name` only for a code people use as a document number.
- Never mount a lookup per row. See [data-access.md](data-access.md).

## Identifiers

- Use the model's `record_label`, else the record UUID, in pickers, relations, headings and approvals. Never duplicate it into a field.
- A relation column names the relation; the target's label renders itself. A picker shows the target's label; `label`, `orderBy`, `limit`, `where` narrow it.
- The compiler rejects a system field as a column or field. Pass identity through the `id` prop.
- An update `Form` needs `id={record.id}` even with `{record}`: `record` supplies values, `id` selects the target and shares the enclosing `RecordShell`'s draft and Save. Create forms omit it. A matching update form delegates submit to the record header: add no second Save.
- A custom control calling `bolt.act` distinguishes committed from `pendingApproval`. After a committed transition, return the matching `useRecordController()?.current` to view, checking model and id. Keep refused edits in the draft. Prevent a transition while the form is dirty. Add no second draft store.

## Kinds on views

- `Show` and `Field` route every value through its kind. A view declares which fields it paints: `Table columns`, `Board card` (at most 4), `Form fields`.
- A `cell` snippet is for composite content only; it takes typed `{ row, value }`.
- `Form` edits exactly the model's allowlist and sends only changed fields.
- A one-relation column shows the target's label; a many-relation shows its first label and a `+N` popover. Labels load in the page's statement. A `cell` on a relation gets the FK id or related rows.
- A model `Table` reads one page at a time by cursor; never pass a whole model as a local array.

## Scope by entity

- A group spanning legal entities, projects, sites or accounts makes that entity the primary scope of every sibling page, not a column in an unfiltered list.
- Shared scope is one group-owned live read in a `*.svelte.ts` module plus each page's header `Picker`. The default is the first in-force row, resolved in `$derived`.
- A read whose `status` is loading is unknown, not empty. Empty means no in-force row: tell the operator to choose one.
- A cross-entity overview shows counts per entity, never mixed time series. A relation column never substitutes for scope.

## Effective-dated lists

Open active-only as an editable `initialFilter` on the period (`contains` today from `bolt.clock('day')`), not a fixed `where`. Charts and current summaries use the active window.

## One home per model

- Settings hold reusable configuration; an operational app holds records for one responsibility; a parent record holds owned values. Never mount a model's `Table` in two apps. If two tabs show the same rows, delete one.
- `ChildGrid` does nested create, update, delete, link and unlink with original revisions. A child may stay readonly while its parent declares the child's write layer. Do not add standalone child grants to enable a parent editor.

## Review

1. Any new one-liner or wrapper? Inline it.
2. Queries and labels in `$derived`, no `$effect` wiring.
3. No N+1, no uuid on screen.
4. Multi-entity pages default to one entity; effective-dated tables to active.
5. Each model in one controller app.
