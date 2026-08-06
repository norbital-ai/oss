---
'@norbital-ai/ui': minor
---

Let a `CollectionTable` view open on a filter the operator can remove.

An effective-dated list wants to open on what is in force today without hiding
that it has done so. Neither existing channel could express that. A condition in
`query.where` is applied invisibly and cannot be cleared — the "Applied by this
view" tooltip can only narrate it after the fact — so surfaces grew a bespoke
"In force today / All history" `ToggleGroup` beside the table instead: a second
filter control, sitting next to the real one, for one hard-coded condition.

`initialFilters` seeds the filter builder itself. Each entry becomes an ordinary
row in the popover — same field picker, same operator list, same operand editor,
same `x` — so the default is visible where every other condition is, counts
toward the filter button's active badge, and can be edited or dropped.

Clearing a seed is remembered against the table's `view`. Interactive filters are
deliberately not persisted, so without that the seed would return on every reload
no matter how often it was dismissed. What persists is the _signature_ of the
cleared seed rather than a bare flag, so an author who later changes the default
gets the new one applied instead of it staying suppressed by a decision taken
about a different condition.

The seed is written in the builder's vocabulary, not the wire's: `field` is the
path the field picker uses, and `value` is what its operand editor produces — a
calendar day for `contains_date`, which `collectionFilterClause` converts to an
instant on the way out. Seeding wire shapes would have meant reversing that
conversion and unwrapping the `%…%` an `ilike` operand is published with.

`query.where` remains the right home for scoping a view is not entitled to widen,
such as the legal entity it belongs to.
