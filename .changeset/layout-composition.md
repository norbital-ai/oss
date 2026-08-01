---
'@norbital-ai/ui': patch
'@norbital-ai/pod': patch
---

Fix `Cover`, and make `Stack` able to express what callers were writing as classes.

`Cover` built its grid rows as `` class={`[grid-template-rows:${rowTemplate}]`} ``. Tailwind emits CSS
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
