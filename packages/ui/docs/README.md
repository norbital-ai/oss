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
| Views               | Table, Board, Form, RecordShell and the other model views of RFC §3.6.                   |

## Boundaries

Entries and the base stylesheet are listed in the [package README](../README.md).

- Keep tenant-specific workflows, data fetching, model hooks, and one-off visual treatment out of
  this package.

Source follows component functions: tables, boards, records, relations, approvals, runs, logs,
charts, matrices, maps, pivots, filters and capture each own their components and supporting code.
`client` declares the structural host contract; `read` owns read presentation, and `effect` owns
query execution and lifetime. Shared text, cells and actions have their own modules; only
`utilities` groups unrelated small helpers. Add companions beside their owner.

## Async reads

Use `Form` and `RecordShell` for record editing; they own loading, drafts and mutation feedback.
Table, Board, RecordShell and the pickers read the caller's view output of the model
(`ModelExposure.output`: `default` when granted, else the first granted named output).
For custom workspace reads, import `bolt` from `$bolt` and capture reactive arguments in `$derived`.
`bolt.query(name, input)` returns a `Query<T>` whose `.current`, `.error` and `.loading` subscribe
when read in a component. The same query reads once when awaited in an event handler and composes
as an Effect with `yield*`.

```svelte
<script lang="ts">
	import { bolt } from '$bolt';
	let { selected } = $props();
	const order = $derived(selected === null ? null : bolt.query('orders', { id: selected }));
	const orders = $derived(bolt.query('orders', { limit: 100 }));
</script>

{#if order?.loading}<p>Loading…</p>{:else if order?.current}<p>{order.current.number}</p>{/if}
```

Identical reads share a subscription, released after a 30-second grace when its last reactive reader
leaves. Changed arguments create a new query; check its loading and error states before showing an
empty result. Live reads receive relevant commits from the host. `aggregate` and `history` use the
same contract. Render a public page's typed `pageServer.load` data during SSR and hydration; browser
queries begin after mount.

Host components with ordinary Effects or Streams can use `observeOnce(() => effect)` or
`observe(() => stream)` from `@norbital-ai/ui/effect`. These component-owned helpers return
`QueryState<A, E>` with `current`, `error`, `loading`, native `AsyncResult` and `refetch`. Read reactive
inputs in the source factory. A `null` source pauses; changing sources discards stale completions.
`{ initial: data }` seeds only the first source's render and hydration.

Derive presentation with `$derived`; use `$state` for user inputs and drafts. Keep the native query's
subscription ownership and avoid copying its answer into a second state machine. The shell mounts
one runtime for `run`, `fork` and `attach`; its disposer interrupts every owned fiber. A host
application provides its own mounted runtime with `mountEdge`.

Keep mutations separate: event handlers use `fork(effect, onFailure)`; an element-owned resource
uses `{@attach attach((node) => effect)}` with scoped acquisition and finalizers. `run(effect)`
remains the explicit Promise bridge. Effects and Streams stay outside Svelte state.

A representation can call `useRecordController()` at component initialization to access its enclosing native
controller. After an action changes the record, refresh from the latest readable row and matching record
capabilities before calling `current.edit()`. Check `historical` first: a displayed revision stays readonly.
The controller retains its field permissions, state locks, drafts and native child editors.

## Toolbar actions

The view toolbar's ⚡ menu derives its standard rows from the model's exposure to the viewer, with no page
configuration: callables and model syncs (remote reads, file Import, Download template and Export),
Export CSV, "Update selected records" (declared and permitted update fields) and "Delete selected records" (declared and
permitted delete). An undeclared or unpermitted row is absent. It watches an import run to its
end in one step: a spinner, then the counts as a toast with any warnings in the menu, or, when a finding refuses, its
findings and nothing written ([Bolt's sync guide](../../bolt/docs/syncs.md)). A page adds ad-hoc rows (running an automation by hand) with
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

Update selected records offers the model's permitted update fields, excluding hidden, derived and
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

`CustomView` takes an optional `model`: the model its rows stand for (a roster grid of `roster_entry`). With
it, the ⚡ menu offers that model's callables and model syncs, scoped by `toolbar.context`, the title defaults to
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
Selection survives paging and clears when its model, scope, filter, sort or search changes, or a successful action
settles. Changing a table's page size also clears it. Clearing or changing a board's selection scope discards an earlier
select-all response that arrives later.

`downloadTextFiles([{ name, content }], 'export.zip')` downloads a text document directly, or
packages a batch into one ZIP. It preserves UTF-8 bytes and disambiguates duplicate names. Reuse
it for generated bulk exports; repeated download clicks can silently lose files to browser limits.

See [native record history](./record-history.md) for the shared revision scrubber and related-record timeline.

- [Time inputs](./time-inputs.md): the public temporal controls, precision and array values.
