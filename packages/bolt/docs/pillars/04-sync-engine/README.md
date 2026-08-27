# P4 · Sync engine

The tenant database is authoritative. Each browser holds a **policy-scoped PGlite replica**
([P5](../05-client/README.md)). Writes go up through `collections.mutate`; subscribed reads are
local. **Collection** is the invalidation unit, not query shape.

Source: `src/runtime/sync/sync.ts`, `src/runtime/sync/wake.ts`,
Colony `src/lib/hosting/sync-distribution.ts`.

---

## Server: outbox, poke, pull

On INSERT / UPDATE / DELETE a PostgreSQL trigger (`bolt_capture_sync_change`, installed by the
schema plan) writes `bolt_sync_outbox` in the **same transaction**, with `mutation_id` from
`bolt.mutation_id`. Pull is commit-ordered (`pg_snapshot_xmin`), not insert-ordered.

| Command             | Role                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync.head`         | Outbox head cursor                                                                                                                                    |
| `sync.pull`         | Bounded partition pull: deltas, cursor advance, mutation confirmations / rejections                                                                   |
| `sync.distribute`   | Host batch: many authenticated pulls sharing one outbox window                                                                                        |
| `sync.partition`    | Partition identity                                                                                                                                    |
| `sync.shape`        | Collections this subject may read                                                                                                                     |
| `sync.provisioning` | DDL + collection metadata for PGlite (does **not** copy the tenant database)                                                                          |
| `sync.schema`       | Immutable facts: fingerprint, migration digest, affected collections                                                                                  |
| `sync.compact`      | Outbox collapse + retention prune. Colony schedules it (post-seed, stream catch-up, `sync-distribution` cadence). Host-only (`SYSTEM_ONLY_COMMANDS`). |

Pull response kinds: `delta`, `cursorExpired`, `rehydrateAdvised`. Recovery never carries deltas;
the client rebuilds active windows before persisting head.

After commit, `SyncWake.announce` publishes `{ collections: [...] }` on `bolt.sync`. Collection
**names only** — not rows or cursors. The write never fails because of wake (250 ms, swallowed).

Colony's SSE stream (`/api/bolt/sync/stream`) fans `ready`, `deltas`, `generation`,
`cursor-expired`, `rehydrate-advised`, `schema-barrier`, `schema-maintenance`,
`schema-maintenance-clear`, `partition-changed` to the replica leader. A `poke` frame exists
in the route file but is **not** written to the browser (`onPoke: () => undefined`); the host
uses poke only internally, then pulls. The host aggregates guest-filtered pulls via
`sync.distribute`.

---

## Partition

Visibility is computed once per partition. `Sync.partitionIdentity` hashes:

`tenantId · environment · effectivePolicyHolder · impersonationTarget · authorityGeneration · schemaFingerprint · policySurface`

`effectivePolicyHolder` is `actor:<userId>` when any read grant is actor-bound; otherwise
`administrator`, `static:<policies>`, `team:<teamPath[0]>`, or `authenticated`. Inside one
partition, visibility and permitted fields are identical → deltas computed once. Schema
fingerprint is part of the key: a new release is a new namespace (always rebuild), never an
in-place row rewrite.

How the holder is chosen: [access](../../access/README.md#replica-partition).

---

## Query and mutation path

**Browser query.** Live query mounts a window → local read if the proof is valid; else
`refillWindow` → server `collections.findMany` (or count / grouped) with a read cursor → install
proof in one PGlite transaction. Window / overlay mechanics: [P5](../05-client/README.md).

**Server / agent / automation query.** `Collections.findMany` in the guest against the host
`database` facility, policy SQL applied.

**Browser mutation.**

1. Journal + overlay (local durable) — P5.
2. Push `collections.mutate` with idempotency key, base versions, schema fingerprint.
3. Server: hooks → policy → txn → history + outbox + `bolt_browser_mutation`.
4. Wake → host drain → SSE `deltas` / `generation` → leader apply → confirm or reject the journal entry.
5. Overlay retires only on exact authoritative confirmation.

**Server-side mutation.** Same `collections.mutate` pipeline without the browser journal; outbox
still written in the transaction.

A stale `schemaFingerprint` is refused. The compiler emits a mutation-compatibility ledger; within
the offline horizon the journal may adapt. Past it, the mutation is quarantined.

---

## What this is not

- Not a full-database download. Website copy that still says `sync.snapshot` is stale.
- Not local-only. Permissions and invariants stay server-authoritative.
- Not a durable server subscription per tab or query. Server durable state is the outbox plus
  generations — O(0) per client query.
