---
name: data-modelling
description: Route data modelling decisions - models, fields, layers, state, invariants, search, migrations.
---

## Protocol

1. Decide the models. Prefer fewer. A value its parent owns, with no identity, lifecycle, permissions, history or relational query of its own, is inline. Configured variation is records; source defines the language.
2. Read the field contract: `import('@norbital-ai/bolt').ModelLiteral`, `FieldKind`.
3. Declare invariants on the model before writing callback code. Use named `constraints` for checks, locks, period exclusions and uniqueness. Declare state edges, indexes and computed values on the model.
4. Declare reads as outputs, writes as columns per layer, with a transform for derived values and a check for business rules. A batch commits whole.
5. Business operations are automations; authority is policies.
6. Declare `record_label` once when a readable identifier exists.
7. Declare `search.text`: it turns on the toolbar search and the finder.
8. Review the generated migration's destructive steps.

## Routing (`authoring-tenant-workspace` skill)

| Need | Reference |
| --- | --- |
| Model or inline value, runtime configuration | `references/model-boundaries.md` |
| Field kinds, links, layers, locks, callbacks, search, syncs | `references/models-and-modeling.md` |
| Dates, periods | `references/dates-and-time.md` |
| Reads, batches, transactions | `references/data-access.md` |
| Seeds, migrations | `references/generated-and-build.md` |
