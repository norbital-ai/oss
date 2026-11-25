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
- **Match cardinality to reality (1:1 vs 1:N) and keep unrelated domains separate:** when a parent owns one primary artifact (e.g. a master model, blueprint, or source file) and at most one derived breakdown/analysis per artifact, put the file directly on the parent (with version/revision metadata) and enforce 1:1 cardinality (`unique: ['<parent>_id']`) on the derived model — rendering the breakdown inline rather than behind a redundant list table. Keep general supporting attachments/documents consolidated under the parent's `Record` tab (e.g. a `Filed Documents` `<Section>`) instead of mixing them with the primary artifact. Keep non-artifact or ad-hoc items (e.g. independent overheads, manual adjustments, standalone costs) in their own owned child model rather than grafting them into an artifact-derived breakdown.
- **No free-text money lines — wire commercial & ad-hoc items to canonical catalogs/artifacts:** commercial documents (orders, contracts, deliveries, invoices, variations) and ad-hoc cost models must pick structured items from a canonical catalog model or artifact-derived breakdown (with required FKs on standalone rows and batched write-callback validation on inline priced lines that derive canonical units/labels server-side) rather than free-text codes, units, or descriptions — enabling exact budget-to-committed-to-paid cashflow reconciliation across a parent entity.
- **Decide the aggregate boundary when designing inputs:** for every parent–child relationship, decide whether parent + children are **one logical entity** (edited together in place via a data matrix — `ChildGrid save="parent"`, `Rows`, or `Form` `acts` — committed in **one Save operation**, e.g. loan + repayments, order + lines) or **independent entities** (separate lifecycle, permissions or volume → own `Table`/`Board`). Never split a one-entity aggregate across separate child drawers or per-row immediate `ctx.act()` writes.
- Before inlining a child model, verify no FK targets, independent approvals/history, or cross-parent reuse are lost. Never replace an enforced FK with an unvalidated string (`custom_field.validate` is pure and cannot query other models — use batched write callbacks). Use native `StructuredData`/matrix editors rather than creating an entity just for a table editor.

## Runtime configuration, schemas & formulas

- Source defines types, operations, evaluator and invariants; authorized records hold rates, thresholds, formulas, schemas, prompts, templates and effective dates. Extend source when needs exceed that language — never build an unrestricted code field or untyped blob.
- Use native `state` + locks + policy checks for publishing configuration; version/snapshot config when past results must stay reproducible. Teams, policies and approval routes remain source only.
- `ctx.ai.sys_2.infer` accepts `output: { json_schema, rules? }` (CEL checks); keep server validation authoritative even when rendering with `StructuredData`. Schema properties pick Bolt datatypes via `format: '<datatype>'` or `"x-norbital": { "datatype": "<name>" }` (checked on `$schema` seeds by `bolt check`/`build`). `text` with `format: 'cel'` supplies the formula editor; source compiles/evaluates with Bolt formula exports.
