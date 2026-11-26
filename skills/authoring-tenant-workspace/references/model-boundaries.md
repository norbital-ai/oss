# Entity boundaries and runtime configuration

Read before adding a model or field, splitting a catalogue, or designing configurable behaviour.

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

- Inline values born, edited, sealed and discarded with the parent (stable item keys, never array index, when items are referenced).

## One fact, one owner

Store every fact once, on the model whose lifecycle it belongs to; everything else reads it there. Before adding a field, name the record that agrees, measures or decides its value.

- Terms agreed in an agreement (amounts, rates, schedules, conditions) live on the agreement, not on the record it serves.
- A party or person is a `ref` to their record (a directory model or `sys_user`), never free text beside a directory that holds them.
- One structure, one encoding: a hierarchy is a parent `ref` or a path code, never both. An identifier and a position are two fields only when they are two facts.
- Refs between two models point one way. A cycle (A → B and B → A) means one side restates the other: keep the side the business records and derive the other.
- History is native: no revision-trail fields, version counters or snapshot arrays; record history keeps every earlier value and who set it. Keep a version label only when the business names its versions.
- A derivable value is a `computed` field, roll-up or pure helper, never a second stored copy.
- A setting lives at one scope (`product-ux`). A field no page shows, no rule reads and no write sets is deleted.

## Shape

- Match cardinality to reality: a parent with one primary artifact keeps it as a field; a breakdown derived from that artifact is a 1:1 model (`unique` on the parent ref) rendered inline, not behind a list. Its fields still sit in the tab of their concern (`product-ux`).
- Priced or measured lines pick from a canonical catalog or artifact-derived breakdown: a required ref on standalone rows, batched write-callback validation on inline lines that derives units and labels server-side. Never free-text codes, units or descriptions.
- Decide the aggregate boundary for every parent–child relation: one logical entity is edited in place and committed in one Save (`ChildGrid save="parent"`, `Rows`, `Form` `acts`); independent children (own lifecycle, permissions or volume) get their own `Table`/`Board`. Never split one entity across child drawers or per-row immediate `ctx.act()` writes.
- Before inlining a child model, confirm no FK target, independent approval or history, or cross-parent reuse is lost. Never replace an enforced FK with an unvalidated string (`custom_field.validate` is pure and cannot query; use batched write callbacks). Use native `StructuredData`/matrix editors rather than a model made only for a table editor.

## Runtime configuration, schemas & formulas

- Source defines types, operations, evaluator and invariants; authorized records hold rates, thresholds, formulas, schemas, prompts, templates and effective dates. Extend source when needs exceed that language — never build an unrestricted code field or untyped blob.
- Use native `state` + locks + policy checks for publishing configuration; version/snapshot config when past results must stay reproducible. Policies and approval routes remain source only; teams are `sys_team` rows an administrator edits.
- `ctx.ai.sys_2.infer` accepts `output: { json_schema, rules? }` (CEL checks); keep server validation authoritative even when rendering with `StructuredData`. Schema properties pick Bolt datatypes via `format: '<datatype>'` or `"x-norbital": { "datatype": "<name>" }` (checked on `$schema` seeds by `bolt check`/`build`). `text` with `format: 'cel'` supplies the formula editor; source compiles/evaluates with Bolt formula exports.
