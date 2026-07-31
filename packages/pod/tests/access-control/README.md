# Access control and the approval flow

**What this pillar protects:** that a record under approval cannot be changed by anyone who has not
been granted it, that a terminal decision leaves the database in exactly the state the decision
implies, and that every client sees that state without being told to go and look.

## Why these tests exist

An approval is the one place where a record's _history_ is the answer. Rejecting a gated update has
to restore values that no longer exist in the live row; rejecting a gated delete has to bring a row
back. Getting that wrong is silent — the record simply reads as something plausible — so each
transition is asserted against real PostgreSQL triggers rather than a service-level stub.

| File                              | Owns                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `approval-lifecycle.test.ts`      | The lock: a pending approval blocks concurrent writes, and a rejected update/delete restores or re-inserts the prior row. |
| `approval-rollback.test.ts`       | Terminal transitions at the trigger level, including that each rollback announces itself on the change feed.              |
| `approval-stale-decision.test.ts` | A decision is computed from the locked row, not from what the approver was shown, and cannot resurrect a replaced flow.   |
| `approval-partial-upsert.test.ts` | An approval row cannot be advanced by a status-only upsert that drops its identity columns.                               |
| `approval-announce-e2e.test.ts`   | A status change reaches a synced client's local `approval_request` row.                                                   |
| `approval-rollback-e2e.test.ts`   | A withdrawn approval drops the rolled-back record from the replica before the command promise settles.                    |

## The layers are deliberate, not duplicated

The same rollback is asserted at four boundaries because four different things can break:

1. the database trigger (atomicity of data, version, history);
2. the authoritative service (which row is locked, which step is stamped);
3. the HTTP/feed layer (what other clients are told);
4. the local replica (what the person who pressed the button now sees).

A pass at one says nothing about the others.

## Not here

Policy-scoped _read_ filtering, which is the sync engine's residency problem and is owned by
`../sync-engine/sync-e2e-comprehensive.test.ts`. Capability restriction for hooks belongs to
[`../hooks`](../hooks/README.md).
