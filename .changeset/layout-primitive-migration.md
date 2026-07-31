---
'@norbital-ai/ui': patch
---

Migrate the component library onto the layout primitives, and widen `LayoutElement` to the semantic
containers that migration needs.

`as` accepts `span`, `article`, `figure`, and `figcaption` in addition to the elements it already
allowed. The union exists to keep `as` to flow and inline containers — not to exclude semantic
sectioning, which is most of the reason to offer `as` at all.

Repairs found while converting: elements whose opening tag became a primitive while their closing tag
stayed `</div>`, a day-cell wrapper left unclosed when its chip row became `<div><Inline>`, comments
sitting in attribute position where Svelte reads them as duplicate attributes, and components
rendering `Inline`, `Bound`, or `Cluster` without importing them. Each of those failed the build
rather than degrading quietly, but they failed it in files the migration had already moved past.
