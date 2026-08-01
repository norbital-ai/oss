# @norbital-ai/ui

## 0.0.13

### Patch Changes

- 0ed8ab6: Fix `Cover`, and make `Stack` able to express what callers were writing as classes.

  `Cover` built its grid rows as ``class={`[grid-template-rows:${rowTemplate}]`}``. Tailwind emits CSS
  by scanning source text, so a class assembled at runtime names a rule that was never generated —
  `Cover` rendered as a bare `grid` with implicit auto rows, which distributes rows evenly. It
  presented as three unrelated bugs: a page header that would not stay at the top, a body that would
  not take the remaining height, and a dialog footer that would not pin to the bottom. A single record
  in a collection table sat centred with equal bands above and below, which read as a phantom row. The
  row template is now an inline style, which Tailwind does not compile and therefore cannot drop.

  `Stack` gains `align`, `justify`, `grow` and `fill`. It had no way to place its children, so every
  caller wrote `flex-1 items-center justify-center` — and against a parent whose height comes from
  `min-h-*` rather than a definite height, that silently does nothing and the content stays at the top.
  The scanner now treats those classes on a primitive as an override (`UI10`), which was only fair once
  the props existed.

  An organization switch evicts the workspace instead of covering it. The request has to reach the
  host, the host has to warm the target runtime, and only then does the document navigate; for that
  whole window the previous organization's records stayed mounted under a translucent overlay and were
  still legible beneath the new organization's name.

  `Center` gains `measure="narrow"`. A login card or a single form has no measure to ask for between
  `reading` and the full width, so call sites wrote `mx-auto max-w-lg` and rebuilt `Center` by hand.

- c4ed91d: Render streamed markdown one block at a time, and keep the organization-switch module runtime-free.

  `ReadonlyMarkdown` put the whole document through a single `{@html}`. `{@html}` cannot patch — it
  assigns `innerHTML` — so every chunk of a streaming assistant message discarded and rebuilt every
  node in that message, and the browser re-laid-out and repainted all of it. Parsing was never the
  cost (marked is under a millisecond even at 14KB); the DOM churn was, and it grew with the length of
  the message. Lexing still covers the whole document, so reference definitions and footnotes resolve
  exactly as before, but each top-level block is parsed and rendered on its own — an unchanged
  paragraph produces a byte-identical string, Svelte's equality check skips it, and only the block
  being written is rebuilt.

  `switchOrganization` no longer holds its own `$state`. Runes compile only in `.svelte`/`.svelte.ts`,
  so a plain module reaching for one throws at runtime while `svelte-check` stays quiet. The shell owns
  the flag instead, which is also what lets the switch contract be tested without a Svelte runtime.

## 0.0.12

### Patch Changes

- b5c5c22: Migrate the component library onto the layout primitives, and widen `LayoutElement` to the semantic
  containers that migration needs.

  `as` accepts `span`, `article`, `figure`, and `figcaption` in addition to the elements it already
  allowed. The union exists to keep `as` to flow and inline containers — not to exclude semantic
  sectioning, which is most of the reason to offer `as` at all.

  Repairs found while converting: elements whose opening tag became a primitive while their closing tag
  stayed `</div>`, a day-cell wrapper left unclosed when its chip row became `<div><Inline>`, comments
  sitting in attribute position where Svelte reads them as duplicate attributes, and components
  rendering `Inline`, `Bound`, or `Cluster` without importing them. Each of those failed the build
  rather than degrading quietly, but they failed it in files the migration had already moved past.

- Updated dependencies [89ca704]
  - @norbital-ai/platform-utils@0.0.12

## 0.0.1

- Initial baseline release of the shared Svelte component library.
- Collection tables, matrices, and split layouts retain desktop behavior until phone widths.
- Mobile bottom sheets support reliable pointer and keyboard resizing.
- Published Svelte output is valid JavaScript for Vite's SSR module runner.
