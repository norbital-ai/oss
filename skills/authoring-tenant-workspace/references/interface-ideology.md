# Interface ideology

The axioms layout, scroll and spacing derive from.

1. **An element never spaces or sizes itself.** Space is granted by a parent or claimed inside a boundary the element draws.
2. **One primitive, one job.** Compose instead of configuring. A primitive with two responsibilities is two primitives nested.
3. **Intrinsic over breakpoints.** Layouts respond to their container; the sidebar changes width without changing the viewport.
4. **One owner per responsibility, per axis, per level.** Scroll, padding and height each have one owner in an ancestor chain. Two scroll owners trap; two padding owners misalign; zero leaves content flush.
5. **Tokens, never values.** Every space, size, ratio and breakpoint is a named token. `p-[13px]` or `w-[420px]` in an app file is a bug.

## Density

- No overlap except through `Imposter` inside a `relative` parent. No raw positioning or z-index.
- Never show one value twice in a region. Do not pair a label with a `Show` of the same field. Section headings are not duplication.
- Readonly records do not repeat a write restriction under every field; `Field` explains it in Edit.
- Check plotted chart labels in the real narrow panel. Keep axis layout in the shared `Chart`.
- Kinds first: `Show` and `Field` before hand-rolled display; a custom field only for what kinds cannot express.

## Records are summaries

Narrow tables summarize records. Choose `columns` and card fields for supporting detail; the identifier is `record_label` or the UUID, never reconstructed per view.
