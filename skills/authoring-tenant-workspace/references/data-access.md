# Data access

Use `query` for every read, in pages and server code. Keep ids, decimals and dates in their platform types. Exact shape: `import('@norbital-ai/bolt').ReadRequest`.

- Decode a text id once with `idOf(model)`; never cast a string to `Id<…>`.

## Read requests

- A read is one JSON layer map. A key without a dot is a root, a model with `read`, at most once per request. A dotted key is a layer of that root's output and implies its parents.
- A root reads one output (`output`, `default` when absent) that a held policy must grant.
- A layer takes `where`, `fields`, `orderBy`, `limit`, `search`, `aggregate`. Only a root takes `output`, `after`, `asOf`.
- A named ref layer replaces its FK with the row or null; a many-layer is its rows.
- The answer maps each root to `{ rows, next, total }`. `total` counts every match in the same statement, linear in the match. An index search root and a nested many-layer carry none: use `aggregate` on that layer.
- A user filter composes with the policy per key (`where` AND, `limit` capped); nothing widens it.
- Every list defaults to limit 10,000 and the root's order; page on with `after`. A complete read past the cap fails `TooLarge`, never truncates.
- Filter and project in the request, never in memory.

| Caller | Reads as |
| --- | --- |
| Page, `ctx.query` in a page loader | the caller |
| Automation | its `policies` |
| Effect | its writer |
| Write callback, policy check, `notify` (`ctx.db.query`) | the workspace, whole rows |
| File sync | the importing or exporting caller |
| Remote sync | trusted workspace |

## Live and one-shot reads in a page

- `bolt.query` subscribes on its first reactive read of `current`, `loading` or `error`. Identical calls share a subscription; it stops after its last reader, with 30 s grace.
- Capture inputs in `$derived`; return null for no selected query.
- Never mirror the answer into `$state`, create a subscription `$effect`, or own timers or generation counters.
- Outside reactivity, `await` reads once; the same Query also yields as an Effect.
- Mutations hold their own operation state through `fork` or `run` from `$bolt`. Keep Effects out of Svelte state. Mounted element resources belong to `attach`.

## Time and operands

- Pass `bolt.clock('day').today` or a minute or hour clock's `now` as literal inputs. See [dates-and-time.md](dates-and-time.md).
- A value position may hold `{ field: '<column>' }` or `{ var: '<CEL>' }` over `requestor` (`id`, `email`, `phone`, `party`, `visitor`, `instance`, `teams`, `teamTree`, `scopes.<policy>`) and the clock, evaluated once per read and checked against the field's kind.
- Time expressions are edge-only: view filters, the agent's read and described filters evaluate them; the store refuses them.
- A prior state of a record is `bolt.history` on a page, or a root `asOf` instant in server code.

## SSR pages

- A public or external page loads through `pageServer.load` with a shared codec and renders synchronously. Later reads use Query. See [apps-and-surfaces.md](apps-and-surfaces.md).

## One read, never N+1

- A relation column renders its target's label natively. A custom page names related data as layers of its one read.
- Never mount a lookup per row. Reads started in the same microtask batch into one round trip and one statement; identical reads deduplicate.
- A read depending on another row's field is a layer through a declared ref, named in `read`.

## Read, then transform

- A computed answer is one read request plus a pure browser-safe `src/lib` helper typed over the rows, called from pages and server code alike. Helpers take time as an argument.
- Add the layers it needs to the root's `read`, narrowed in the root's policy where needed.
- Server checks stay in write callbacks, so a client preview is safe. An export too heavy for the page is a file sync.

## Writes

- Every generated write takes an array, so callbacks and the policy see the whole batch.
- Parent and children belong in one act through write layers: a create row carries child arrays (an id links a non-owned row); an update `set` carries `{ create, update, delete, link, unlink }` per layer.
- `ctx.act.many` commits independent writes together. `ctx.act.checked` does the same for dynamic JSON inputs; its outputs stay JSON. Prefer `many` when inputs are typed.
- A durable automation holds several transactions, so separate acts are not atomic.
- A transform computes every id first, prefetches in at most two reads, then decides per row without crossings.

## Transactions

- When writes depend on a current read or an earlier write, use `ctx.transaction(function* (tx) { … })`: one session, read-your-writes, one commit, a fixed five-second deadline on PostgreSQL 17+. PGlite refuses it.
- Yield only `tx.query` (no `asOf`) and `tx.act`. Facilities, captured outer Effects, raw SQL, nesting and async callbacks are forbidden: finish external work first.
- `tx.act` uses the standard guards. Inner answers are provisional. The outer answer is `committed` with output and records, or held with a `requestId` and no callback output. A refusal or failure rolls everything back. Refuse by throwing the typed refusal from the errors module.
- Pass no manual revision maps inside; upserts still need `onConflict`. Return native values or void. The callback is never replayed.

## Observed revisions

An automation that reads, waits for external work, then writes passes `{ observed: { [id]: revision } }` to `ctx.act`, so a newer edit conflicts instead of being overwritten. Handle `committed` and `pendingApproval` honestly: the latter is written and held.

## Aggregates

- Counts, sums and groups use a root or layer `aggregate`, `bolt.aggregate`, or roll-up fields, never loops.
- Ungrouped answers one object (`count` only when asked); grouped pages buckets, each with `key` and `count`.
- View counts describe the full authorized scope: reuse them. A figure reused across screens is a roll-up or a shared helper.

## Search

`{ search: { index: input }, limit }` on the same API. The probe's `where` narrows inside the scan; output and grants apply; rerank orders candidates.
