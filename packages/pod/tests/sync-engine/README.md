# Sync engine

**What this pillar protects:** that a read answered from the local replica is the same answer the
server would have given, and that a write is visible locally before its response settles without
ever becoming the authority.

The normative contract is [`docs/SYNC_ENGINE.md`](../../docs/SYNC_ENGINE.md). Every clause there has
an owner here; a clause with no owner is not a contract.

## Why these tests exist

The sync engine's failure mode is not a crash. It is a screen that looks correct and is not: an
empty table over rows that exist, a record that was deleted a minute ago, a count taken over a
window. None of those raise anything, so each one is asserted directly.

| File                             | Owns                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `client-sync.test.ts`            | Local query compilation, and the completeness rules that decide local vs server: residency, windows, pinned keys, relations, search.      |
| `pod-sync-client.test.ts`        | Catch-up, cursor persistence, schema reconciliation, optimistic writes and rollback, offline queue, epoch reset, bind-parameter chunking. |
| `subscription-registry.test.ts`  | Collection registration, the shared residency byte budget, restored-state freshness, and failed catch-up retry.                           |
| `outbox-and-write-guard.test.ts` | The `_ops_guard` write barrier, atomic co-commit of data/version/outbox, and safe-watermark tailing under concurrent transactions.        |
| `sync-compaction-reset.test.ts`  | A cursor that falls behind retention is reset rather than resumed across a hole — including while the stream is still connected.          |
| `sync-notify-coalescing.test.ts` | Change-feed `NOTIFY` fires once per statement carrying the highest seq. This is sync transport, not user notification delivery.           |
| `sync-http-e2e.test.ts`          | Real socket and SSE framing: propagation, backlog order, cursor-only progress for unsubscribed rows, scope-reset, UUIDv7 refusal.         |
| `sync-e2e-comprehensive.test.ts` | Product convergence against a compiled runtime: policy scoping, multi-client, reload, shared replica, search parity, a million rows.      |
| `sync-runtime-contract.test.ts`  | Timestamp fidelity across the replica boundary, and that the introspected schema applies to a fresh replica.                              |
| `replica.test.ts`                | The SharedWorker bridge handshake and per-tab port isolation.                                                                             |
| `organization-switch.test.ts`    | A switch is a full-document boundary, and a failed session update leaves the current workspace intact.                                    |
| `remote-query-family.test.ts`    | Live-resource family identity, so re-shaping a slice never blanks a table and a new page never shows the old one.                         |
| `base64url.test.ts`              | The cursor codec round-trips non-Latin values. Wrong encoding silently restarts every reconnect at zero.                                  |

## Deliberate overlap

`sync-http-e2e` and `sync-e2e-comprehensive` both drive a real runtime. They are not duplicates:
the first owns the wire (framing, filtering, cancellation, control frames), the second owns what the
product observes (convergence, residency, mutation identity, reload, scale).

Approval visibility appears here only as a feed concern; the approval lifecycle itself belongs to
[`../access-control`](../access-control/README.md).

## Not here

Anything that merely restates a TypeScript type, snapshots generated SQL without executing it, or
mocks the replica to assert the mock. A sync test that cannot fail on a real database is not
evidence about sync.
