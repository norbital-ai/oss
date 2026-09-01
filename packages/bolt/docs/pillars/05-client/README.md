# P5 · Client

The browser client is a **pure Machine reducer** plus drivers. `machine.ts` holds all observable
state — versioned prefixes, pending writes, link status — and `step()` is the only place state
changes. `applyPrefixDelta` (`src/client/live-query/project.ts`) is the sole applier for host
deltas. `project()` paints pending optimistic writes over the retained prefixes. Two drivers move
bytes: one SSE stream in, serialized HTTP control/write calls out. `runtime.ts` is wiring.

Source: `src/client/sync/` (`machine.ts`, `client.ts`, `sse-driver.ts`, `http-driver.ts`),
`src/client/live-query/` (`project.ts`, `stable-key.ts`), `src/client/runtime.ts`,
`src/client/ui/shell/`.

---

## The Machine

| Piece            | Job                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Reducer**      | `step(state, event) → [state, effects]`; pure, no timers, no transport                       |
| **Queries**      | One entry per stable query key: input, versioned prefix, requestedPrefix, phase (`pending` / `fresh` / `failed`), subscribers |
| **Writes**       | One entry per idempotency key: graph, phase (`queued` / `sent`)                              |
| **Link**         | `live` / `reconnecting` / `closed` — the Machine's own `ClientState`                         |
| **Effects**      | `register` (connect / reconnect / reset), `extend` (grow a prefix), `push` (write), `restart` |

The client wrapper (`client.ts`) owns the imperative edges: serialized control HTTP on a promise
tail, a deadline-driven clock, and write pushes. **No timer asks the server what changed** —
everything is push, retry-backoff, or an explicit mount.

`createBrowserSyncBroker` (`sse-driver.ts`) elects one owner tab with Web Locks and shares frames
over BroadcastChannel. **One EventSource per browser profile** is shared across tabs and
workspaces — not per user and not per workspace. Each tab still owns its own Machine and in-memory
write queue. There is no IndexedDB tenant database.

- `syncStatus` is the Machine's reactive `ClientState` (`sync-status.svelte.ts`), re-exported by
  the generated framework. The shell reads `link` and `writes` through ordinary reactivity; every
  Machine transition lands in the same step that applies the frame.
- A release mismatch disconnects the stream. `closed` is terminal. `reconnecting` retries with
  capped backoff.
- A prefix update applies only when the retained version equals the update's `fromVersion` and
  `toVersion` is the next integer; otherwise the link restarts. A reset is always legal: the
  browser drops the prefix and re-registers.
- Retention: a released query's prefix is retained for `DETACH_GRACE_MS` (30 s) so remounting is
  free; a sent write unacknowledged for `STALE_WRITE_MS` (15 s) is retried.

---

## App-facing API

```ts
import { client } from '$bolt/client';
const employees = client.db.employees.findMany({ where, orderBy, with, limit, after });
await client.db.claims.mutate(graph);
client.db.claims.pending; // numeric in-flight write count
```

Reads: `findMany` / `findFirst` with a contiguous limit are **live** — a prefix registered with
the host and pushed thereafter. `count`, `findGrouped`, an `after` cursor, and semantic search
are **one-shot**: answered once over the transport and never filed live.

Writes: one verb `mutate` (plus `delete`) submits a declarative graph and resolves immediately
with the optimistic row. Durability is `'memory'` — this tab's queue — and the returned handle
exposes `settlement` / `status` / `wait`. Settlements are `accepted | rebased | rejected |
quarantined`; nothing is claimed saved before its outcome. `project()` overlays pending graphs on
the retained prefix so the UI updates same-frame.

The shell (`src/client/ui/shell/`) owns workspace navigation, the agent panel, sync status, omni
finder, and notifications. Colony's workspace shell (`workspace-shell.svelte`) opens the workspace
in online mode at **5 s** (`continueOnline`) if bootstrap has not finished.

---

## What this is not

- Not a replica and not a second source of truth. The browser holds current prefixes in memory
  only; a failed revalidation yields `failed`, never a confident stale answer.
- Not one EventSource per tab. The profile-local broker shares one stream; the Machine stays
  per-tab.
- Not a poller. No timer asks the server what changed.
- Not CRDT text or field-level merge beyond disjoint-field reconciliation.
