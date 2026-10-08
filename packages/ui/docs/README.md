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

- Import from `.`, `./layout` or `./capture`, never `src/` or `build/`.
- Import `@norbital-ai/ui/base.css` once at an application root. Bolt does this for generated tenant
  clients, so a tenant must not add a second base stylesheet or Tailwind integration.
- Keep tenant-specific workflows, data fetching, collection hooks, and one-off visual treatment out of
  this package.

## Toolbar actions

The view toolbar's ⚡ menu wires the collection's callables, integration sync, `+pipeline.ts` feeds (Import…
for JSON or xlsx, Download template, Export), Export CSV and Delete selected by itself. It watches an import run to its
end: a spinner, then the counts as a toast, or its findings in the menu with "Accept and import" when they are only
warnings (Bolt's `docs/pipelines.md`). A page adds rows with `toolbar.actions`, each
pure configuration:

```ts
toolbar={{
	actions: [
		{ icon: 'lucide:check', name: t('settle'), description: t('settle_hint'), requiresSelection: true,
			run: (ids) => bolt.act('obligation.update', { target: ids, set: { state: 'FULFILLED' } }) },
		{ icon: 'lucide:refresh-cw', name: t('refresh'), run: () => bolt.start('catalogue_refresh', {}) }
	]
}}
```

The menu derives each row's state from what `run` returns: nothing closes the menu; a promise is
pending (spinner, disabled) then Done, or its rejection shown in the row and as a toast; an `Outcome` is
toasted and a refusal is the row's error; a run handle shows its run under the toolbar.
`requiresSelection` lists the row under Bulk and turns selection on; `disabled(selected)` returns why
it cannot run now.

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

A table that selects rows (`toolbar.select`, `delete`, or a `requiresSelection` item) selects a page through the
grid's header checkbox, or through the card list's "Select this page" on a narrow view. Once a whole page is selected,
"Select all N matching" adds every row the scope and filter match (one id-only read). The selection survives paging and
is cleared when the filter, sort, search or page size changes. "Select all N matching" needs the view's row count, so a
text search does not offer it.
