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
- Every list defaults to limit 10,000 and the root's order; page on with `after`. A complete read past the cap fails `TooLarge`, never truncates.
- Filter and project in the request, never in memory.

| Caller | Reads as |
| --- | --- |
| Page | the caller |
| Automation | its `policies` |
| Effect | its writer |
| Write transform, policy verdict (`ctx.query`) | the workspace, whole rows |
| File sync | the importing or exporting caller |
| Remote sync | trusted workspace |

## Live and one-shot reads in a page

- `ctx.query` subscribes on its first reactive read of `current`, `loading` or `error`. Identical calls share a subscription; it stops after its last reader, with 30 s grace.
- Capture inputs in `$derived`; return null for no selected query.
- Never mirror the answer into `$state`, create a subscription `$effect`, or own timers or generation counters.
- Outside reactivity, `await` reads once; the same Query also yields as an Effect.
- Mutations hold their own operation state through `fork` or `run` from `@norbital-ai/ui/effect`. Keep Effects out of Svelte state. Mounted element resources belong to `attach`.

## Time and operands

- Pass `ctx.clock('day').today` or a minute or hour clock's `now` as literal inputs. See [dates-and-time.md](dates-and-time.md).
- A value position may hold `{ field: '<column>' }` or `{ var: '<CEL>' }` over `requestor` (`id`, `email`, `phone`, `party`, `visitor`, `instance`, `teams`, `team_tree`, `scopes.<policy>`) and the clock, evaluated once per read and checked against the field's kind.
- Time expressions are edge-only: view filters, the agent's read and described filters evaluate them; the store refuses them.
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

An update or delete names its selected row as `target`; its revision guards the write even after external work. There is no separate observed-revision map. An act yields `committed` or `pending_approval`; refusals, conflicts and uncertain writes are typed failures. A pending approval is written and held.

## Aggregates

- Counts, sums and groups use a root or layer `aggregate`, or roll-up fields, never loops. Pages also expose `ctx.aggregate`; server bodies use the nested read request.
- Ungrouped answers one object (`count` only when asked); grouped pages buckets, each with `key` and `count`.
- View counts describe the full authorized scope: reuse them. A figure reused across screens is a roll-up or a shared helper.

## Search

`{ search: { index: input }, limit }` on the same API. The probe's `where` narrows inside the scan; output and grants apply; rerank orders candidates.
