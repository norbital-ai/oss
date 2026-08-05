---
'@norbital-ai/pod': patch
---

Compile `contains_date` and `overlaps` on raw collection `where` objects, and reject unknown filter
operators with a 400.

`contains_date` and `overlaps` are Pod's own `dateRange()` operators, not Drizzle's. Only the
explicit `CollectionFilter[]` controls compiled them; a raw `where` — the shape the authoring skill
documents for prefilling effective-dated lists to "active now" — passed validation untouched and
reached Drizzle, whose field-filter compiler calls `operators[key](column, value)` and threw
`operators[target] is not a function`. The local replica does implement both operators, so the
optimistic rows rendered and the server round-trip then failed in the UI.

Raw `where` objects now compile both operators to the same RAW SQL predicate the filter controls
already produced, at the top level, inside `AND`/`OR`/`NOT`, inside a field-level `AND`/`OR`/`NOT`,
inside a relation filter object, and inside a nested `with` selection. Any operator key that is
neither Drizzle's nor Pod's is now a 400 naming the collection, the field, the operator, and the
accepted set, instead of a `TypeError` from inside Drizzle.
