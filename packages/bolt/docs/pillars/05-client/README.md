# P5 · Client and replica

The browser holds a policy-scoped PGlite replica. Live queries answer from it when a window proof
is valid. The server ([P4](../04-sync-engine/README.md)) stays authoritative for permissions and
invariants.

Source: `src/client/runtime.ts`, `src/client/replica/*`, `src/client/ui/shell/`.

---

## Replica (shipped)

Bootstrap calls `sync.provisioning` + `sync.shape` and creates local tables. **No full snapshot.**
First reads hydrate bounded authoritative windows.

| Piece                | Job                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------- |
| **Base store (O3)**  | PGlite: one row per `(collection, record_id)` per partition, version-gated               |
| **Overlay (O4)**     | Pending mutations projected over base; not written to O3                                 |
| **Mutation journal** | `await mutate()` = locally durable + overlay reflected, not yet committed                |
| **Window (O5)**      | One per canonical query; proof metadata; refill is one bounded authoritative page        |
| **Positions (O6)**   | Durable partition cursor + per-collection generations, advanced with the rows they cover |
| **Leader**           | One Web Locks leader per partition owns the SSE stream; followers re-read durable state  |
| **Budget**           | OPFS (≤ 10 GiB), IndexedDB (adaptive), or server-only fallback                           |
| **Schema barrier**   | Leader-only namespace switch; old namespace is never migrated in place                   |

Moves in code: **M1** `applyDeltas`, **M2** `refillWindow`, **M3** `rebuildNamespace` /
`rehydrateActive`, plus journal settlement (`accepted` / `rebased` / `rejected` /
`quarantined`). Nothing labels an unproven result fresh. Nothing silently discards a pending
mutation.

The replica already holds policy-scoped rows. A local read combines `authoredWhere` and
`userFilter` (`AND`), then applies `orderBy`, then pagination (`local-reads.ts`).

Server partition identity is computed in `Sync.partitionIdentity`; see
[P4](../04-sync-engine/README.md#partition) and [access](../../access/README.md#replica-partition).
The browser names local storage with a second key (`ReplicaPartitionIdentity` in `leader.ts`):
`tenant · environment · principal · authority · formatVersion`. `formatVersion` is the replica
layout, not the tenant schema fingerprint.

---

## App-facing API

```ts
import { client } from '$bolt/client';
const q = client.db.employees.findMany({ where, orderBy, with, limit, after });
await client.db.claims.mutate(graph);
```

The shell (`src/client/ui/shell/`) owns workspace navigation, the agent panel, sync status, omni
finder, and notifications. Colony's workspace shell (`workspace-shell.svelte`) opens the
workspace in online mode at **5 s** (`continueOnline`) if bootstrap has not finished.

---

## What this is not

- Not a second source of truth. A broken proof yields one bounded page, never a confident partial
  answer and never a full resync.
- Not CRDT text or field-level merge beyond disjoint-field reconciliation.
- Not a per-tab server subscription. Followers share the leader's PGlite and do not open a
  second SSE stream. The leader applies deltas and refills; followers re-read durable state.
