---
agent: true
authoring: true
name: data-modelling
description: Route data modelling decisions - models, fields, layers, state, invariants, search, migrations.
---

## Protocol

1. Consolidate models before naming tables. Merge same-stream variants that share a parent, feed and actor into one polymorphic model (`kind` + discriminated-union custom datatype or shaped `json`); split only when lifecycles, permissions or foreign-key targets diverge.
2. Co-locate compound values and keep attributes minimal. Never scatter one concept across loose scalar pairs or parallel columns: prefer built-in kinds (`period`, `money`, `state`, `count`, `file`) first, then a reusable custom datatype. Every field must serve an active view, calculation, invariant or query.
3. Match storage and write boundaries to persistence semantics: inline owned values that live and seal with one parent; use an owned child model (written atomically via nested layers or one `act` map) when rows need identity, FKs or independent queries; use an append-only `locked` transactional ledger with offsetting entries and derived balances for authoritative accounting, entitlement or balance facts. Configured variation is records; source defines the language.
4. Read the field contract: `import('@norbital-ai/bolt').ModelLiteral`, `Kind`.
5. Declare invariants on the model before writing callback code. Use named `constraints` for checks, locks, period exclusions and uniqueness. Declare state edges, indexes and computed values on the model.
6. Declare reads as output trees and writes as column trees. Transforms derive and validate values; policy verdicts judge caller authority. A batch commits whole.
7. Business operations are automations; authority is policies.
8. Declare `record_label` once when a readable identifier exists; add a text `indexes` entry for searchable fields beyond it. Review the generated migration's destructive steps.

## Routing (`authoring-tenant-workspace` skill)

| Need                                                        | Reference                           |
| ----------------------------------------------------------- | ----------------------------------- |
| Model or inline value, runtime configuration                | `references/model-boundaries.md`    |
| Field kinds, links, layers, locks, callbacks, search, syncs | `references/models-and-modeling.md` |
| Dates, periods                                              | `references/dates-and-time.md`      |
| Reads, batches, transactions                                | `references/data-access.md`         |
| Seeds, migrations                                           | `references/generated-and-build.md` |
