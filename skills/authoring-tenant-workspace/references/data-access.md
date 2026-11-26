# Data access

Use `query` for every read. Exact shape: `import('@norbital-ai/bolt').ReadRequest`. Decode text IDs once with `id_of(model)` (never cast to `Id<…>`).

## Read requests

- JSON tree: roots map to models, relations are nested keys (`{ orders: { fields: ['number'], customer: { fields: ['name'] } } }`; no dotted path keys). Selecting a ref in `fields` returns its ID; naming the relation returns its row(s).
- Root takes `output` (default `'default'`), `after`, `as_of`; layers take `where`, `fields`, `order_by`, `limit`, `search`, `aggregate`. Native views (`Table`, `Board`, `Map`, `RecordShell`, pickers) pick `default` if held else first granted named output; `ctx.query` names its output explicitly.
- Answer per root: `{ rows, next, total }` (`total` counts all matches; index search & nested many-layers use `aggregate` instead).
- Pass explicit `limit` (default cap 10,000) and narrow named `outputs`; paginate chronologically with monotonic UUIDv7 `order_by: { id: 'desc' }` (or `'asc'`), following `next` via `after` until `null` for complete sets. Filter and project in SQL, never in memory.
- Caller read authority: Page = caller; Automation = its `policies`; Effect = its writer; Transform/verdict `ctx.query` = workspace whole rows; File sync = caller; Remote sync = trusted workspace.

## Reactivity, clocks & operands

- `ctx.query` (`PageBolt.query`) subscribes live over SSE on first reactive read (`current`/`loading`/`error`), shares identical queries, and keeps 30s grace + up to 64 inactive client-memory images revalidated by SHA-256 on re-entry (never persisted to browser storage; cleared on release cutover/sign-out).
- Capture inputs in `$derived` (return `null` for no query). Never mirror into `$state`, poll with `setInterval`, or wire `$effect` refetches. Outside reactivity, `await` reads once or yield as Effect. Run mutations via `fork`/`run` from `@norbital-ai/ui/effect`; mounted DOM resources via `attach`.
- Pass materialized clock values (`ctx.clock('day').today`, `ctx.clock('minute'|'hour').now`); store refuses relative clock variables in read predicates. Value positions accept `{ field: '<col>' }` or `{ var: 'actor.<name>' }` (`id`, `email`, `phone`, `visitor`, `instance`, `party`; `teams`/`team_tree` under `in` on a ref to `sys_team` only).
- Past states: `ctx.history` on pages, root `as_of` in server code.

## No N+1, transforms, writes & aggregates

- Batch lookups with `in` filters or nested relation layers — never mount per-row lookups or N+1 `ctx.query` loops (same-microtask reads batch automatically). Compute derived views with one read + a pure `src/lib` helper taking time as an argument.
- Every write verb takes an array. Commit parent+children via nested write layers, or multi-model writes in one atomic `ctx.act({ '<model>.<verb>': inputs })` map using `new_id(model)` to link upfront (separate acts in an automation are separate transactions).
- Select `revision` for audited update/delete targets (`{ target: row, set }` / `{ target: row }`). Acts yield `committed` or `pending_approval`; refusals/conflicts are typed failures.
- **Aggregates:** `{ by?, count?: true, sum?|avg?|min?|max?: [field], where? }` (`by` supports `{ day|week|month|quarter|year: field }`); page grouped buckets with `limit`/`after`.
- **Search:** `{ search: { <index>: input }, limit }` or `/semantic <text>` (hybrid vector top-K + FTS RRF).
