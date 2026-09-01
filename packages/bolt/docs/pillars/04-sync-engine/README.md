# P4 · Sync engine

The tenant database is authoritative. The browser holds no replica: each live query is a
**contiguous prefix** registered with the host, the host re-evaluates that prefix on every relevant
commit, and committed state is **pushed** as a version-fenced keyed delta — or a reset that forces
the browser to re-register. Guest commands are `sync.connect`, `sync.extendPrefix`, and
`sync.advance`. The browser never calls `sync.advance`; the host does, after a commit.

Source: `src/runtime/sync/` (`sync.ts`, `delta-engine.ts`), structured admission in
`src/runtime/access/effective-plan.ts`, wire `bolt-protocol/src/sync.ts`, shared
`SyncRegistry` / `SyncConnectionLane` in `bolt-protocol/src/sync-registry.ts`. Colony implements
the host: `apps/colony/src/lib/hosting/sync-host.ts`, `sync-conductor.ts`, and the public URLs
`/__bolt/sync/connect`, `/__bolt/sync/extend`, `/__bolt/sync/stream`. bolt-server uses the same
lane.

---

## Guest: connect, extend, advance

`compileEffectiveQueryPlan` is the query and read-policy compiler. A plan is either `live-prefix`
or `one-shot`. Live admission is `findMany` / `findFirst` with a contiguous limit (default 100,
max 1 000). `count`, `findGrouped`, an `after` cursor, and semantic search are one-shot and are
never filed live. An opaque policy predicate cannot be a live plan. Lexical search may be live;
prefix continuation then needs an ordering cursor the search planner owns, or the wake resets.

| Command              | Who calls it                         | Role                                                                                          |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `sync.connect`       | Browser (and reconnect / reset)      | Resolve each requested prefix, return rows plus the plan the host will file.                  |
| `sync.extendPrefix`  | Browser, monotonic grow              | Append rows past the viewer's loaded prefix without bumping version.                          |
| `sync.advance`       | Host, after a commit                 | Re-evaluate filed prefixes against the commit's `SyncChange` list; return updates or resets.  |

`sync.connect` carries `queries` (`queryKey`, `input`, `requestedPrefix`), `detached` keys, and
`pending` write ids. `sync.extendPrefix` carries `queryKey`, `version`, `loadedPrefix`, and
`requestedPrefix`. `sync.advance` carries the commit's `changes`, the host-held subscriptions
(prefix keys, version, viewer prefixes, and the credential the guest re-authenticates), `pending`,
and an optional `writer` so ledger outcomes can ride the same frame.

A `SyncChange` is `insert` / `update` / `delete` with `before` and/or `after` **link-and-route
values**, not an id-only wake. The write transaction projects those fields in the same commit that
mutates the row (`compactSyncChanges` collapses per-id transitions). There is no changelog cursor,
no `bolt_sync_outbox`, and no digest of held ids.

`advanceActivePrefix` walks the plan's reverse paths on the old and new graphs, point-probes
affected roots through the ordinary collection resolver, fills vacated slots from the retained
boundary, and emits one keyed delta per attached viewer prefix (`removeIds` + `put` at a final
index). A plan-key or authority mismatch, a broken prefix, or a byte/row ceiling is a
**reset** (`stale-version`, `prefix-limit`, `prefix-bytes`, `inconsistent-prefix`, `plan-changed`,
`policy-changed`, `release-changed`, `authority-changed`) — not a full-answer patch on the wake.

---

## Host: one registry, one lane per scope

`SyncRegistry` and `SyncConnectionLane` are the shared mechanism Colony and bolt-server use
directly. Each host supplies a connection object, the guest-call bridge, scope/lane choice, and
disconnect mapping. Filing, invalidation, ordering, and emission live in the shared core:

- **One plan per `planKey`.** The subscription id is `hash(planKey)`. The plan holds version,
  prefix keys, retained bytes, authority fingerprint, dependencies, and routing constraints.
  Several connections may attach as viewers with different `loadedPrefix` lengths.
- **`byCollection` from the plan's dependencies.** A commit wakes plans indexed under a changed
  collection. Routing constraints may prune a wake using the change's `before` / `after`; a
  matching held id, a root-collection change, or an empty routing set still wakes the plan.
- **One serialized lane per `(tenant, environment, releaseId)`.** `connect`, `extendPrefix`, and
  `committed` enqueue on that lane. The host **awaits** lane acceptance before the commit call
  returns. An unwritable sink, an oversized or invalid frame, a guest failure, or a version that
  moved during publication **closes the uncertain connections** (`guest-failed`). There is no
  best-effort commit log to replay a missed wake.
- **`releaseId` is part of the scope key.** A release mismatch disconnects the stream. Colony
  wraps each apply as a `SyncScopedApplyFrame` so one physical EventSource can carry several
  workspace scopes.

The host hashes and files opaque guest facts. It does not resolve a subject, evaluate a predicate,
or construct a delta — evaluation belongs to the guest and the database.

The Live Query Sync v2 RFC still wants a refused lane to fail the mutation response. Both hosts
await the lane and close on uncertainty; Colony then logs a delivery failure and still returns the
HTTP write.

---

## Browser: one EventSource per profile

The browser Machine (`src/client/sync/machine.ts`) holds versioned prefixes, pending writes, and
link state (`live` / `reconnecting` / `closed`). `step()` is the only place that state changes.
`applyPrefixDelta` (`src/client/live-query/project.ts`) is the sole applier. A frame that does not
continue every retained `fromVersion` is a protocol error and restarts the link.

`createBrowserSyncBroker` (`src/client/sync/sse-driver.ts`) elects one owner tab with Web Locks
and shares frames over BroadcastChannel. **One EventSource per browser profile** is shared across
tabs and workspaces. Public Colony URLs:

| URL                      | Verb | Job                                              |
| ------------------------ | ---- | ------------------------------------------------ |
| `/__bolt/sync/connect`   | POST | Register or re-register prefixes; settle pending |
| `/__bolt/sync/extend`    | POST | Grow a viewer's loaded prefix                    |
| `/__bolt/sync/stream`    | SSE  | `apply` frames (`updates`, `resets`, `outcomes`) |

Control posts send `x-bolt-sync-connection`. Writes go over `collections.mutate` with the same
header. A released query's prefix is retained for `DETACH_GRACE_MS` (30 s); a sent write
unacknowledged for `STALE_WRITE_MS` (15 s) is retried.

Ceilings: `MAX_SYNC_LOADED_KEYS` = 1 000, `MAX_SYNC_INITIAL_ANSWER_BYTES` = 2 MiB,
`MAX_SYNC_OUTBOUND_FRAME_BYTES` = 2 MiB, `MAX_SYNC_RETAINED_PREFIX_BYTES` = 8 MiB.

---

## Write path

1. The browser enqueues one declarative graph into the Machine and posts it with the connection
   header. Durability is `'memory'` — the tab's queue — until the authority settles it.
2. The guest runs the one mutation pipeline (hooks → policy → transaction → history → capture).
   Capture writes `SyncChange` facts and a `bolt_browser_mutation` ledger row in that same
   transaction.
3. The host awaits `lane.committed`. The guest `sync.advance`s affected subscriptions. The lane
   emits one apply frame per connection that needs a delta, a reset, or a write outcome.
4. Settlements are `accepted | rebased | rejected | quarantined`. Nothing is claimed saved before
   its outcome.

A stale `schemaFingerprint` is refused; a schema transition rebases the write (`rebased` carries
the from/to fingerprints). `collections.resume` is the approval-release verb.

---

## Invariants

1. **I1 — the database is the only predicate evaluator.** Prefix resolution calls the one
   authoritative collection resolver under the compiled effective plan; no sync-specific SQL
   dialect exists.
2. **I2 — dependencies over-report.** Relation and policy dependencies come from the same
   compiler as the SQL and reverse paths; an unknown relation falls back conservatively.
   Over-reporting costs re-evaluations; under-reporting loses liveness.
3. **I3 — one commit, one lane turn, one apply per connection.** A commit's prefix deltas,
   resets, and write settlements reach a connection as one reducer event.
4. **I4 — version fences every delta.** A patch applies only when the client's retained version
   equals the update's `fromVersion` and `toVersion` is the next integer; otherwise the link
   restarts. A reset is always legal: the browser drops the prefix and re-registers.

---

## What this is not

- Not a replica, not a local database. The browser keeps current prefixes in memory; nothing
  durable is stored client-side.
- Not local-only. Permissions and invariants stay server-authoritative on every answer.
- Not a durable server subscription per tab or query. Server durable state is the tenant
  database and the browser-mutation ledger; per-scope registry state is O(live plans), and a
  reconnect re-resolves.
- Not a changelog, digest chain, or outbox. Those artifacts are gone; a missed wake is a
  closed stream, not a replayable log.
