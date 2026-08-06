---
'@norbital-ai/ui': patch
---

Constrain and compact the collection form field-history popover.

The popover grew unbounded and overflowed the viewport. Its `max-h-64` (and the
`max-h-32` on each value) were passed to `Scroll`, which composes classes as
`cn(className, ...)` — so `tailwind-merge` dropped both in favour of the
primitive's own `max-h-full`. With no height cap, Floating UI could not contain
it: `flip`/`shift` only reposition the content, and the `size` middleware just
publishes `--bits-floating-available-height` without applying it. The height cap
now lives on the tooltip content itself, where it survives class merging, and
the scroll region fills it.

Each revision is now a single dense line — value plus timestamp — instead of a
bordered card wrapping a `StructuredValue` table, which removes the nested
borders and the horizontal scrollbar. Revision timestamps use the day-month-year
convention (`05 Aug 2026, 14:32`) and resolve in the viewer's timezone.

`Tooltip` also forwards `avoidCollisions` and `collisionPadding` (defaulting to
`true` and `8`), matching `Combobox`; Bits UI otherwise leaves collision padding
at `0`.
