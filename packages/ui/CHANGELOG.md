# @norbital-ai/ui

## 1.0.2

### Patch Changes

- @norbital-ai/std@1.0.2
- @norbital-ai/platform-utils@1.0.2

## 1.0.1

### Patch Changes

- @norbital-ai/std@1.0.1
- @norbital-ai/platform-utils@1.0.1

## 1.0.0

### Minor Changes

- 15ccf98: Type `CollectionForm` `Field` so each usage infers `rendererProps` from the chosen `renderer`. Required renderer props (for example `RelationshipRenderer`'s `target`) are enforced, and nested callbacks such as `options.label` infer their record parameter without `satisfies CollectionRelationOptions`. Removes the open index signature on `CollectionFormRendererOptions` that previously collapsed that inference.

### Patch Changes

- 0bee7b9: Fix the day and week calendar views importing `#lib/utils/pixel-drag.js` with an extension the `#lib/utils/*` subpath appends itself, which resolved to `pixel-drag.js.js` and failed any build that reached the event calendar.
- 82bc0b2: Fix MatrixRenderer painting both wide and narrow layouts (scoped CSS on the wrong nodes) and stop unbounded matrices from trapping parent vertical scroll inside forms and sheets.
  - @norbital-ai/std@1.0.0
  - @norbital-ai/platform-utils@1.0.0

## 0.0.1

### Patch Changes

- Svelte component library and design tokens for Norbital tenant applications.
