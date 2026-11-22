# Entity boundaries and runtime configuration

Read before adding a model, splitting a catalogue, or designing configurable behaviour.

## Storage hierarchy (fewest models)

Do not map every prompt noun or UI tab to a model. Prefer in order:

| Need | Use |
| --- | --- |
| Scalar/pair with built-in meaning (range, money, state, count, file) | built-in field kind (never loose scalar pairs or duplicated sub-fields) |
| Same-stream variants sharing parent, timeline & actor | one polymorphic model (`kind` + union custom datatype or shaped `json`) |
| Reusable compound value with validation/editor | `custom_field` + `+renderer.svelte` |
| Child rows needing FKs, row queries or independent edits under parent | owned child model (`inverse`; commit atomically with parent via layers/`act`) |
| Authoritative accounting, balance, inventory or entitlement facts | append-only `locked` ledger model (offsetting entries, derived balance) |
| Independent identity, lifecycle, permissions, history or relational queries | separate model (nest child folders under owner: `data/model/<root>/<child>/`) |
| Reused effective-dated business variation (rates, thresholds, rubrics, schemas) | validated runtime configuration model |
| Derivable figure | `computed` field, `sum`/`count` roll-up, or read + pure helper |

- Drop speculative fields with no active consumer. Inline values when born, edited, sealed and discarded with the parent (use stable item keys, never array index, when items are referenced).
- Before inlining a child model, verify no FK targets, independent approvals/history, or cross-parent reuse are lost. Never replace an enforced FK with an unvalidated string (`custom_field.validate` is pure and cannot query other models — use batched write callbacks). Use native `StructuredData`/matrix editors rather than creating an entity just for a table editor.

## Runtime configuration, schemas & formulas

- Source defines types, operations, evaluator and invariants; authorized records hold rates, thresholds, formulas, schemas, prompts, templates and effective dates. Extend source when needs exceed that language — never build an unrestricted code field or untyped blob.
- Use native `state` + locks + policy checks for publishing configuration; version/snapshot config when past results must stay reproducible. Teams, policies and approval routes remain source only.
- `ctx.ai.sys_2.infer` accepts `output: { json_schema, rules? }` (CEL checks); keep server validation authoritative even when rendering with `StructuredData`. Schema properties pick Bolt datatypes via `format: '<datatype>'` or `"x-norbital": { "datatype": "<name>" }` (checked on `$schema` seeds by `bolt check`/`build`). `text` with `format: 'cel'` supplies the formula editor; source compiles/evaluates with Bolt formula exports.
