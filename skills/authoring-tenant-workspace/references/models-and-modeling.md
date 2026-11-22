# Models and modeling

Every field is required unless `optional: true`. Exact shape: `import('@norbital-ai/bolt').ModelLiteral`, `Kind`.

## Field kinds

| Kind | Rule |
| --- | --- |
| `text` | `format`: `email` (case-folded), `phone`, `url`, `zone`, `markdown`, `cel`; `many` |
| `int`, `number`, `decimal`, `money` | `decimal`/`money` are exact (Effect `BigDecimal`, never floats); `money` rounds to currency minor unit unless `scale` |
| `currency`, `bool`, `point`, `vector` | `point` `{ lat, lng }`; `vector` `dim` ≤2000, `metric` |
| `date`, `instant`, `time`, `duration`, `period` | see [dates-and-time.md](dates-and-time.md); `instant` named `*_on`/`*_date` is refused |
| `enum`, `state` | `enum`: `values`, `many`, `transitions`; `state`: `initial`, `states: { s: { to, stamp? } }` (edit exceptions via `locked` constraint) |
| `seq` | patterned number, never reused; `{yyyy}` in workspace zone; `per` scope; `start` floor |
| `sum`, `count` | roll-ups over relationship `inverse`, optional `where` |
| `json`, `file`, `custom` | `json` typed by `shape`; `file` requires `accept` + `max` (≤20 MiB); `custom` `of` workspace or built-in datatype |

- Common keys: `optional`, `default`, `hidden`, `many`, `was` (rename-safe). System columns (`id`, `revision`, `created_at`, `created_by`, `updated_at`, `updated_by`) are reserved. No inline `label`/`help` (use message catalog).
- Date/instant defaults accept `{ var }` clocks; ref defaults accept `{ var: 'actor.id' | 'actor.party' }`.
- `record_label`: pure CEL over own fields and one-hop default-output `ref`s (no clocks; use conditionals for optionals and `string()` for numbers). Materialized and indexed automatically; outputs must expose its dependencies or UI falls back to UUID.

## Relations, constraints & layers

- Foreign key: `{ kind: 'ref', to, inverse, optional?, owned?, on_delete?, where?, default? }` (`to` array = polymorphic; two refs on a join model = M:N). `on_delete`: `restrict` (default), `cascade`, or `set_null` (optional only); owned refs cascade.
- Named `constraints`: `unique` (array; one `import_key: true` enables `import`), `check`, `no_overlap` (periods), `locked` (`except` lists editable fields; blocks all writers including admins; own direct fields only; children need own lock), optional `message: '<catalogue key>'`. `computed` lives on fields.
- `outputs`: nested `{ fields, <rel>: { ... } }` trees (`outputs.default` exposes read root; narrower audiences get narrower named outputs). `create`/`update`: column trees (`fields` array + nested many-relation layers up to 5 levels + `transform` + `effect`; `create.filled` marks transform-filled fields). Updates name explicit child ops `{ create, update, delete, link, unlink }` (nothing deleted by omission). Root model's policies govern every layer.

## Write callbacks, operations & search

- Create/update `transform(changes, ctx)` receives `{ before, set, after, changed }` (`after` has `set` applied; read `c.after.x`, never `c.set.x ?? c.before.x`). Return sets in order or `{ sets, with, on_approved }`; delete transforms receive `before` and return void or `{ with, on_approved }`.
- `with`/`on_approved` carry storage writes `{ [model]: { create?, update?: [{ target, set }] } }` (no target transforms/verdicts/effects/triggers; native constraints/locks/history apply). `with` holds/rolls back with root; `on_approved` commits on final approval (`ctx.approving` re-runs transform — return only `on_approved`).
- Prefetch batch lookups in ≤2 `ctx.query` reads (`as_of: 'act'` sees prospective writes), never per row. 1000-row chunk cap: 3s CPU, one transaction across chunks. Share pure validators in `src/lib`.
- Business operations are automations (`+<model>_<op>.automation.ts`) taking `{ kind: 'rows', of: '<model>' }` inputs; no named model actions or public upserts.
- `indexes`: `{ text: [...] }`, `{ semantic: { fields, model, dim } }`, `{ on: [...] }`, or custom vector (`description`, `dim`, `metric`, pure `vector`, `input`, `probe`, optional `rerank`, `candidates` 1–16).

## Syncs, notices & custom fields

- `+<sync>.sync.ts` beside `+model.ts`: `sync('<model>', '<sync>', { ... })`.
- **Remote sync:** `with: '<integration>'`, required `policies` (no `actor.*` except `actor.instance`), optional `every`/partitions, `read` (`rows` with `$id`/`$version`/`$deleted`, `cursor`, `more`), `write` (returns `$id`/`$version` or `null`). Engine owns no-echo, FIFO, idempotency, retries, backoff (1m→1h), approval wait, rollback, dead letters, and fan-out across active accounts.
- **File sync:** `with: 'file'`, `parser` (or custom IANA `type`/extensions/generator), optional schema/context; runs under caller's grants/scope; one refusal rolls back the file.
- Per-verb `effect` sends custom notices via `ctx.notify`; PDFs of records use `ctx.convert.record`.
- `custom_field({ description, shape, validate? })` + optional light `+renderer.svelte` (`{ view }` with `on_change`).
