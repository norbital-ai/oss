# Custom datatype renderers

A custom field gives a reusable structured value a type, validation and optional presentation.
It is an inline value, not another entity: add a separate model only when identity, lifecycle,
authority, history or relational queries require one.

```ts
// src/data/custom_field/rating/+definition.ts
import { customField } from '@norbital-ai/bolt';
export default customField('rating', {
	description: 'A score from one to five.',
	shape: { kind: 'int', min: 1, max: 5 }
});
```

The optional `validate` callback sits in that literal. The model uses
`{ kind: 'custom', of: 'rating' }`. Without a renderer, Bolt shows and edits the value using its
shape. A supplied `data/custom_field/rating/+renderer.svelte` takes
`{ view }: { view: CustomFieldView<'rating'> }` from `@norbital-ai/bolt`.

In show mode `view` supplies `value`, `dense`, `row` and `name`; edit mode also supplies
`onChange(next)`, `disabled` and `error`. `address` is available beside an address field. Preserve
nullability and write typed values through `onChange`, without round-tripping them through JSON.

The renderer is used automatically in Table cells (dense), Board cards, Form and RecordShell
fields, history diffs, Matrix labels and bulk relation pickers. Built-in money, file, point and
phone renderers follow the same lookup and reserve their names. Renderers are statically bundled
because cells render synchronously; keep them light and import heavier tools only on demand.
