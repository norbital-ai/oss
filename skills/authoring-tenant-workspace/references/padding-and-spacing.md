# Padding and spacing

- **Sibling spacing:** parent's `gap` (margins `mt-*`/`mb-*`/`ml-*`/`space-y-*` are banned in app files; use nested `Stack` for a different rhythm).
- **Boundary interior:** `pad` on the element drawing the border/card (never pad a cramped card's parent).
- **Page edge (`inset`):** owned once per region by its scrollport (`Scroll inset`, `Bound inset`, or `Tabs` panel). Never write literal `px-4 sm:px-6`, and align full-bleed views (`Table`, `Board`, `CustomView`, timelines, canvases) flush with `ViewToolbar` — never wrap them in extra outer padding.
  - `inset` pads only if no ancestor pads; nested `Tabs` add no second gutter.
  - `Sheet`/`Dialog`/`Popover` start a new region (`flush` delegates to first inner scrollport).
  - Verify `[data-bound-inset]`, `[data-scroll-inset]` or padded tab panel appears exactly once between shell edge and content (no zero-pad `full` body, no double-pad).
- **Scale:** `gap`/`pad` tokens `none` (0), `xs` (0.25rem), `sm` (0.5rem), `md` (1rem), `lg` (1.5rem); `xl` (2rem, `gap` only). Never combine `pad` and `inset` on one box.
