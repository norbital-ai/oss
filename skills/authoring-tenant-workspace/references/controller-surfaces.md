# Controller surfaces

Multi-entity and effective-dated pages, without leaking system identifiers. Field visibility and forms: [app-structure.md](app-structure.md).

- **Reactivity:** hold inputs in `$state` and derive reads in `$derived` (check `current` / `error` / `loading`; no `$effect` query wiring; never per-row lookups, see [data-access.md](data-access.md)). Inline one-off lookups, pickers and `—` fallbacks.
- **Identifiers:** rely on `record_label` (UUID fallback; `—` when unresolved); never copy it into a field or paint raw IDs. Relation columns and pickers resolve target labels themselves.
- **Custom transitions:** a custom `bolt.act` button distinguishes `committed` from `pending_approval`, blocks transitions while the form is dirty, keeps a refused edit in the draft, and returns to `use_record_controller()?.current` after a committed transition.
- **Kinds on views:** `Show` / `Field` format by kind; `Board` cards show at most 4 fields; `cell` snippets only for composite display (`{ row, value }`). Model `Table`s page by cursor; never pass a whole model as a local array.
- **Entity and date scope:** sibling pages of one scope share one group-owned live read (`*.svelte.ts`) and one header `Picker` defaulting to the first in-force row (loading ≠ empty; cross-entity overviews show counts per entity, never mixed time series). Every sibling filters its `Table` / `Board` with `where` and opens `RecordShell mode="create"` with the scope ref in `values`; none is left unscoped. Effective-dated lists open active-only through an editable `initial_filter` (`contains` `ctx.clock('day').today`), not a fixed `where`.
- **One home per model:** reusable configuration in the configuration app, operational records in operational apps, owned values in their parent record. Never mount one model's `Table` in two apps, and never repeat a child's own children on the grandparent. Planners and boards show their own entity only.
- Nested child operations use `ChildGrid`: the parent's write layer authorizes them without standalone child grants.
