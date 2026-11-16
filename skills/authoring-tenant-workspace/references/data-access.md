# Data access

Use `query` for every read, in pages and server code. Keep ids, decimals and dates in their platform types. Exact shape: `import('@norbital-ai/bolt').ReadRequest`.

- Decode a text id once with `id_of(model)`; never cast a string to `Id<…>`.

## Read requests

- A read is one JSON tree: each model names a root and each relation is a nested key. For example, `{ orders: { fields: ['number'], customer: { fields: ['name'] } } }`. Dotted path keys are not a request shape.
- A root reads one output (`output`, `default` when absent) that a held policy must grant.
- A layer takes `where`, `fields`, `order_by`, `limit`, `search`, `aggregate`. Only a root takes `output`, `after`, `as_of`.
- A named ref layer replaces its FK with the row or null; a many-layer is its rows.
- The answer maps each root to `{ rows, next, total }`. `total` counts every match in the same statement, linear in the match. An index search root and a nested many-layer carry none: use `aggregate` on that layer.
- A user filter composes with the policy per key (`where` AND, `limit` capped); nothing widens it.
- A policy filters an output's rows with `where`, and a layer's with `<relation>: { where }`. Own rows: `outputs: { default: { where: { created_by: { eq: { var: 'actor.id' } } } } }`. An output grant's keys are `where`, root `history` and the model's relations; nothing else (no `scope`).
- Every list defaults to limit 10,000 and the root's order. A root returns `next` when more rows remain; pass it as `after` until it is `null` before treating the rows as a complete set. Do not calculate full-book totals from a partial page.
- Filter and project in the request, never in memory.

| Caller | Reads as |
| --- | --- |
| Page | the caller |
| Automation | its `policies` |
| Effect | its writer |
| Write transform, policy verdict (`ctx.query`) | the workspace, whole rows |
| File sync | the importing or exporting caller |
| Remote sync | trusted workspace |

A remote sync's pages write as its `policies`; a file's rows as the member importing.

## Live and one-shot reads in a page

- `ctx.query` subscribes on its first reactive read of `current`, `loading` or `error`. Identical calls share a subscription; it stops after its last reader, with 30 s grace.
- Capture inputs in `$derived`; return null for no selected query.
- Never mirror the answer into `$state`, create a subscription `$effect`, or own timers or generation counters.
- Outside reactivity, `await` reads once; the same Query also yields as an Effect.
- Mutations hold their own operation state through `fork` or `run` from `@norbital-ai/ui/effect`. Keep Effects out of Svelte state. Mounted element resources belong to `attach`.

## Time and operands

- Pass `ctx.clock('day').today` or a minute or hour clock's `now` as literal inputs. See [dates-and-time.md](dates-and-time.md).
- A value position may hold `{ field: '<column>' }` or an actor variable `{ var: 'actor.<name>' }`, resolved per caller in policies and reads alike (an automation's actor matches nothing). Each fits one kind: `id` a `sys_user` ref (`created_by`, `updated_by`), `email`/`phone` text of that format, `visitor` text, `instance` a `sys_integration` ref, `party` any ref; `teams`/`team_tree` (team-format text) and `scopes.<policy>` (refs) only under `in`. `check`, `unique` and a ref's `where` take none.
- Clock variables (`today`, `now`) are edge-only: view filters, the agent's read and described filters materialize them; the store refuses them, so pass clock values. Actor variables are not edge-only.
- A prior state of a record is `ctx.history` on a page, or a root `as_of` instant in server code.

## SSR pages

- A public or external page uses `ctx.query` during server rendering, hydration and live updates. See [apps-and-surfaces.md](apps-and-surfaces.md).

## One read, never N+1

- A relation column renders its target's label natively. A custom page names related data as layers of its one read.
- Never mount a lookup per row. Reads started in the same microtask batch into one round trip and one statement; identical reads deduplicate.
- A read depending on another row's field uses a nested relation in the output.

## Read, then transform

- A computed answer is one read request plus a pure browser-safe `src/lib` helper typed over the rows, called from pages and server code alike. Helpers take time as an argument.
- Add its layers to the root's output and scope them in the root's policy where needed.
- Server checks stay in write callbacks, so a client preview is safe. An export too heavy for the page is a file sync.

## Writes

- Every generated write takes an array, so callbacks and the policy see the whole batch.
- Parent and children belong in one act through write layers: a create row carries child arrays (an id links a non-owned row); an update `set` carries `{ create, update, delete, link, unlink }` per layer.
- One act map commits all its writes together: `yield* ctx.act({ 'orders.update': [{ target: order, set: { note } }], 'entry.create': [entry] })`. A runtime-built map uses the same native boundary and keeps JSON outputs.
- A durable automation holds several transactions, so separate acts are not atomic.
- A transform computes every id first, prefetches in at most two reads, then decides per row without crossings.

## Revisions

An update or delete names its selected row as `target`; its revision guards the write even after external work. There is no separate observed-revision map. An act yields `committed` or `pending_approval`; refusals, conflicts and uncertain writes are typed failures. A pending create or update is written and held; a pending delete leaves its rows until approval deletes them.

## Aggregates

- Counts, sums and groups use a root or layer `aggregate`, or roll-up fields, never loops. Pages and server bodies use the same read request.
- Ungrouped answers one object (`count` only when asked); grouped pages buckets, each with `key` and `count`.
- Shape: `{ by?, count?: true, sum?|avg?|min?|max?: [field], where? }`; `by` is a field, a list, or `{ <day|week|month|quarter|year>: field }`. Set the root's `limit` and follow `next` with `after` when a grouped aggregate has more buckets. A bucket is `{ key: { <by> }, count, sum: { <field> } }`.
- View counts describe the full authorized scope: reuse them. A figure reused across screens is a roll-up or a shared helper.

## Search

`{ search: { index: input }, limit }` on the same API. The probe's `where` narrows inside the scan; output and grants apply; rerank orders candidates.

## Browser reuse and freshness

Identical live reads in one mounted client share one subscription. A read remains live for 30 seconds after its last consumer leaves, so a quick return uses its current image without another request. After that, its subscription ends; up to 64 inactive authoritative images (4 MiB total) stay in that client's memory. Re-entry sends the read and the image's SHA-256. The server authorizes and executes the read again: an equal answer sends a small `same` frame, a changed answer sends the current value, and a refusal exposes no retained value. An inactive image is never presented as freshly validated before this response. Active views receive selected row patches; uncertain changes fall back to an authoritative read.

The cache belongs to one client, workspace, environment and principal. It is not persisted to browser storage or shared across workspace origins. Release changes clear retained images; signing out or replacing the client ends its cache. A missing, evicted or invalid image takes the normal full-answer path. Reuse saves transfer, never permission checks or freshness checks.
