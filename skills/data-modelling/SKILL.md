---
agent: true
authoring: true
name: data-modelling
description: Route data modelling decisions - models, fields, layers, state, invariants, search, migrations.
---

## Protocol

1. Consolidate before naming tables: merge same-stream variants sharing parent, timeline and actor into one polymorphic model (`kind` + discriminated-union custom datatype or shaped `json`); split only when lifecycles, permissions or FK targets diverge.
2. Co-locate compound values: prefer built-in kinds (`period`, `money`, `state`, `count`, `file`) first, then reusable custom datatypes — never loose scalar pairs or unused speculative fields.
3. Match storage to persistence semantics: inline parent-bound values; use owned child models (written atomically via nested layers or one `act` map) when rows need identity, FKs or row queries; use append-only `locked` transactional ledgers with offsetting entries and derived balances for accounting/entitlement facts; keep supported variation in validated runtime configuration models.
4. Check shapes via `import('@norbital-ai/bolt').ModelLiteral`, `Kind`. Declare native `constraints` (checks, locks, `no_overlap`, `unique`), `state` edges, `indexes` and `computed` fields before callback code.
5. Declare reads as output trees and writes as column trees. Transforms validate/derive; policy verdicts judge caller authority; batches commit whole. Business operations are automations.
6. Declare `record_label` once when a readable identifier exists, plus text `indexes` for extra searchable fields. Review destructive migration steps.

## Routing (`authoring-tenant-workspace`)

| Need                                                        | Reference                           |
| ----------------------------------------------------------- | ----------------------------------- |
| Model vs inline value, runtime configuration                | `references/model-boundaries.md`    |
| Field kinds, links, layers, locks, callbacks, search, syncs | `references/models-and-modeling.md` |
| Dates, periods                                              | `references/dates-and-time.md`      |
| Reads, batches, transactions                                | `references/data-access.md`         |
| Seeds, migrations                                           | `references/generated-and-build.md` |
