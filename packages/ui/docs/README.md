# UI package

`@norbital-ai/ui` is the shared visual system for Norbital interfaces and Bolt tenant apps.

## Goal

Give applications accessible, consistent Svelte components and layout primitives while keeping domain
logic and tenant presentation decisions in the workspace that uses them.

## What belongs here

| Layer               | Responsibility                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Design foundation   | Tokens, base styles, typography, colour, editor themes, logos, and favicons.             |
| Portable primitives | Buttons, cards, dialogs, inputs, layout primitives, navigation, and feedback components. |
| Views               | Table, Board, Form, RecordShell and the other collection views of RFC §3.6.              |

## Boundaries

Entries and the base stylesheet are listed in the [package README](../README.md).

- Keep tenant-specific workflows, data fetching, collection hooks, and one-off visual treatment out of
  this package.

Source follows component functions: tables, boards, records, relations, approvals, runs, logs,
charts, matrices, maps, pivots, filters and capture each own their components and supporting code.
`client` declares the structural host contract; `read` owns read presentation, and `effect` owns
query execution and lifetime. Shared text, cells and actions have their own modules; only
`utilities` groups unrelated small helpers. Add companions beside their owner.

## Async reads

Use `Form` and `RecordShell` for record editing; they own loading, drafts and mutation feedback.
For custom reads, call `query(() => effect)` or `live(() => stream)` during component initialization.
Both return `QueryState<A, E>`: reactive `current`, `error`, `loading` and `result`, a
`refetch(): Effect<void>` trigger, and Svelte `subscribe` for the current value. `query` composes
`Stream.fromEffect` into `live`; compose transformations with native Effect and Stream operators.
Tenant pages import `query`, `live`, `run`, `fork` and `attach` from `$bolt`, which re-exports
`@norbital-ai/ui/effect`.

Read reactive inputs inside the source factory, before constructing the Effect or Stream:

```ts
const order = query(() => (selected === null ? null : bolt.get('orders', selected)));
const orders = live(() => bolt.live(bolt.read('orders', { limit: 100 })));
```

The shared state tracks those inputs, interrupts the previous source and discards stale completions.
Changing sources clears the previous value and failure; returning `null` pauses with no loading.
`current` is undefined before an answer and after a failure; `error` retains the typed failure `E`.
`result` is the native `AsyncResult` and preserves its full Cause: use its `Failure` tag to include
defects in failure presentation. An empty completed stream has `Initial` with `loading: false`;
a successful page with `rows: []` is an answer. Check these states before presenting an empty view.
The first stream value ends loading, and a later failure clears the value, including on lost access.
`refetch()` restarts the source; its answer arrives through the same state. Live reads already receive
relevant commits from the host.

`{ initial: data }` seeds the first render and hydration from a `pageServer.load` answer. Sources
are not evaluated during SSR; they start after client mount. Render available initial content even
while `loading` is true, and never perform another browser read before hydration. The initial value
does not carry into a different source scope.

Keep fetched values in the shared state and derive their presentation with `$derived`; use `$state`
for user inputs and drafts. Do not mirror query state or add per-query watchers, subscriptions or
generation counters. The shell mounts one runtime for the edge; its disposer interrupts every fiber
started there. A host application provides its own mounted runtime with `mountEdge`.

Keep mutations separate: event handlers use `fork(effect, onFailure)`; an element-owned resource
uses `{@attach attach((node) => effect)}` with scoped acquisition and finalizers. `run(effect)`
remains the explicit Promise bridge. Effects and Streams stay outside Svelte state.

A representation can call `useRecordController()` at component initialization to access its enclosing native
controller. After an action changes the record, refresh from the latest readable row and matching record
capabilities before calling `current.edit()`. Check `historical` first: a displayed revision stays readonly.
The controller retains its field permissions, state locks, drafts and native child editors.

## Toolbar actions

The view toolbar's ⚡ menu derives its standard rows from the collection's exposure to the viewer, with no page
configuration: callables, integration sync, `+pipeline.ts` feeds (Import… for JSON or xlsx, Download template, Export),
Export CSV, "Update selected records" (declared and permitted update fields) and "Delete selected records" (declared and
permitted delete). An undeclared or unpermitted row is absent. It watches an import run to its
end: a spinner, then the counts as a toast, or its findings in the menu with "Accept and import" when they are only
warnings (Bolt's `docs/pipelines.md`). A page adds ad-hoc rows (running an automation by hand) with
`toolbar.actions`, listed under Actions, each pure configuration:

```ts
toolbar={{
	actions: [
		{ icon: 'lucide:check', name: t('settle'), description: t('settle_hint'), requiresSelection: true,
			run: (ids) => bolt.act('obligation.update', { target: ids, set: { state: 'FULFILLED' } }) },
		{ icon: 'lucide:refresh-cw', name: t('refresh'), run: () => bolt.start('catalogue_refresh', {}) }
	]
}}
```

The menu derives each row's state from what `run` returns: nothing closes the menu; an Effect is
pending (spinner, disabled) then Done, or its typed failure is shown in the row and as a toast.
An act's committed or pending-approval answer is toasted; a start Effect's `id` and `automation`
let the toolbar show its live run. Return the Effect directly; the toolbar owns its execution
and teardown.
`requiresSelection` turns selection on and disables the row until records are selected; without it the row runs
with whatever is selected (possibly none). `disabled(selected)` returns why it cannot run now.

Update and delete are disabled with "Select records first" until records are selected. Delete confirms in-app,
naming the count and that it cannot be undone, then deletes each record on its own and reports the result:
"3 deleted" or "3 deleted, 1 kept: <refusal>".

Update selected records offers the collection's permitted update fields, excluding masked, hidden, derived and
readonly fields. Check each field to include it, enter its value, then apply once to the selected IDs.
Unchecked fields stay untouched; explicit false, zero and null values are retained. The native update
enforces every record's grants and state restrictions and reports refusals or pending approval in the menu.

`toolbar.controls` holds scope controls beside the label. `toolbar.trailing` accepts a compact
snippet at the right edge, before New, for task controls such as a tooltip icon button. Keep page
operations in the actions menu unless the task needs a direct control.

`Matrix` accepts the same optional `toolbar`. Omitting it preserves a matrix without toolbar
chrome. Custom cells can queue owned-child changes in their enclosing `FormState` with
`queueChildren`; omit `edit` and `move` when those changes must be saved together.
Its `columnHeader({ col, label })` snippet can place a shared input in a column heading, such as
the repayment date above an amount cell. Omitting it renders the column label.

## Form invariants

`form.addValidation(rule)` registers a synchronous rule returning `SemanticIssue[]`
(`{ field, message }`) and returns its unregister. Rules may read `$state` and the draft; their issues
are `form.semanticErrors`, re-evaluated as values change, so fixing a value clears its issue at once.
`field` is any key the rule chooses (`repayments.3.amount`): a generated `Field` of that name shows it
like a field error, and a custom cell reads `form.semanticError(key)` to highlight itself.
`form.canSave` is `canSubmit` plus no pending save, no `errors` and no issues; every native Save uses
it, and `submit()`, `prepare()` and `validate()` refuse while an issue remains. `canSubmit` stays
permission-only, so an invalid field is never locked.

## Text formats

A text field's `format` picks its editor and viewer: `email`, `phone` and `url` are links, `zone` is a time-zone picker
and `markdown` is the rich-text editor. `cel` is a CEL expression: the record form edits it in a wrapped `CodeEditor`,
the readonly form shows it there read-only, and a table cell shows it as wrapped code. It works on a leaf of a json
`shape` as well, so a structured value's expressions need no editor of their own. `CodeEditor` takes `wrap` for the same
line wrapping anywhere else.

## Custom views

`CustomView` takes an optional `collection`: the collection its rows stand for (a roster grid of `roster_entry`). With
it, the ⚡ menu offers that collection's callables and pipeline feeds, scoped by `toolbar.context`, the title defaults to
its label, and New opens its create (`toolbar.new: false` hides it). Search, filter and sort stay on the view's own rows
and columns.

## Money and selection

A `money` value always shows its currency's minor units (`SGD 5,884.70`, `JPY 1,200`). Without any currency (none on
the row, none in the workspace), it shows two places (`5,884.70`). A `decimal` keeps only the digits it has
(`1,234.5`): declare an amount as `money`, not `decimal`, so it reads as one.

Table and Board select records by default when the catalogue permits edits, deletes or record actions,
or an author item needs the selection. `toolbar.select: false`, `toolbar.actions: false` and
`toolbar: false` disable selection; `toolbar.delete: false` hides the generated delete action.
A table selects its page through the grid's header checkbox, or through "Select this page" on a narrow view. A board's
checkbox selects every loaded card across its lanes and pages, including cards outside the scroll window. Each card
also has its own checkbox; its other content still opens the record and supports dragging. Once the loaded records are
selected, "Select all N matching" adds every matching ID with one id-only read. A searching board offers "Select all"
without a count. Authored board lanes also constrain that read, so it cannot select records outside the displayed lanes.
Selection survives paging and clears when its collection, scope, filter, sort or search changes, or a successful action
settles. Changing a table's page size also clears it. Clearing or changing a board's selection scope discards an earlier
select-all response that arrives later.

`downloadTextFiles([{ name, content }], 'export.zip')` downloads a text document directly, or
packages a batch into one ZIP. It preserves UTF-8 bytes and disambiguates duplicate names. Reuse
it for generated bulk exports; repeated download clicks can silently lose files to browser limits.

See [native record history](./record-history.md) for the shared revision scrubber and related-record timeline.

- [Time inputs](./time-inputs.md): the public temporal controls, precision and array values.
