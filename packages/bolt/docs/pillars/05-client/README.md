# P5 · Client

The browser client is a **pure Machine reducer** plus drivers. `machine.ts` holds all observable
state — current query answers, pending writes, link status — and `step()` is the only place state
changes. `project()` paints pending optimistic writes over the held answers. Two drivers move
bytes: one SSE stream in, serialized HTTP control/write calls out. `runtime.ts` is wiring.

Source: `src/client/sync/` (`machine.ts`, `client.ts`, `sse-driver.ts`, `http-driver.ts`),
`src/client/live-query/` (`project.ts`, `stable-key.ts`), `src/client/runtime.ts`,
`src/client/ui/shell/`.

---

## The Machine

| Piece            | Job                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------- |
| **Reducer**      | `step(state, event) → [state, effects]`; pure, no timers, no transport                       |
| **Queries**      | One entry per stable query key: input, digest, held answer, phase (`pending` / `fresh` / `failed`), subscribers |
| **Writes**       | One entry per idempotency key: graph, phase (`queued` / `sent`), attempts                    |
| **Link**         | `live` / `reconnecting` / `needsReload` — the Machine's own `ClientState`                     |
| **Effects**      | `connect` (handshake or revalidation), `push` (write), each run by the client wrapper        |

The client wrapper (`client.ts`) owns the imperative edges: one SSE stream, serialized control
HTTP on a promise tail, a deadline-driven clock, and write pushes. **No timer asks the server what
changed** — everything is push, retry-backoff, or an explicit mount.

- `syncStatus` is the Machine's reactive `ClientState` (`sync-status.svelte.ts`), re-exported by
  the generated framework. The shell reads `link` and `writes` through ordinary reactivity; every
  Machine transition lands in the same step that applies the frame.
- `needsReload` comes from a release-mismatch disconnect (HTTP 409/426 on the stream): the
  running bundle is stale and the workspace reloads. `reconnecting` retries with capped backoff.
- A patch applies only when the held digest equals the patch's `from`; a mismatched digest marks
  the query pending and revalidates it. A full answer is always a legal fallback.
- Retention: a released query's answer is retained for `RETAIN_MS` (30 s) so remounting is free;
  a sent write unacknowledged for `STALE_WRITE_MS` (15 s) is retried.

---

## App-facing API

```ts
import { client } from '$bolt/client';
const employees = client.db.employees.findMany({ where, orderBy, with, limit, after });
await client.db.claims.mutate(graph);
client.db.claims.pending; // numeric in-flight write count
```

Reads: `findMany` / `findFirst` / `findGrouped` are **live** — mounted once and pushed thereafter.
`count` is live too and re-counts on every wake. A cursored read (`after`) is **one-shot**: the
page is answered once over the transport and never registered live.

Writes: one verb `mutate` (plus `delete`) submits a declarative graph and resolves immediately
with the optimistic row. Durability is `'memory'` — this tab's queue — and the returned handle
exposes `settlement` / `status` / `wait`. Settlements are `accepted | rebased | rejected |
quarantined`; nothing is claimed saved before its outcome. `project()` overlays pending graphs on
the held answer so the UI updates same-frame.

The shell (`src/client/ui/shell/`) owns workspace navigation, the agent panel, sync status, omni
finder, and notifications. Colony's workspace shell (`workspace-shell.svelte`) opens the workspace
in online mode at **5 s** (`continueOnline`) if bootstrap has not finished.

---

## What this is not

- Not a replica and not a second source of truth. The browser holds current answers in memory
  only; a failed revalidation yields `failed`, never a confident stale answer.
- Not a poller. No timer asks the server what changed.
- Not CRDT text or field-level merge beyond disjoint-field reconciliation.
