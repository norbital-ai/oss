# Pod sync-engine specification

Status: normative. This document defines the supported sync behavior of `@norbital-ai/pod`.
Implementation commentary and future ideas are not part of the contract.

Normative words (`MUST`, `MUST NOT`, `SHOULD`) have their usual requirements meaning.

## 1. Contract

The sync engine provides four guarantees:

1. A read that the replica can prove complete MUST execute locally.
2. A read that the replica cannot prove complete MUST execute on the server and its returned rows
   MUST be folded into the replica.
3. A create, update, or delete MUST be visible in the replica before its server response settles.
4. The server remains authoritative for policy, hooks, approvals, validation, audit, history, and
   optimistic-concurrency checks.

Application code uses the generated `$pod/client`. It MUST NOT own cache invalidation, refetch
cycles, sync cursors, or replica lifecycle.

## 2. Ownership and isolation

The client owns a PGlite replica. In browsers, PGlite runs in a `SharedWorker` when supported so all
same-origin tabs use one serialized database writer. A deterministic tab-local database is used only
when SharedWorker startup fails; shared and tab-local databases never use the same storage path.

A replica is named by `replicaStamp = <organizationId>:<userId>`. Rows from one organization or user
MUST NOT be opened as another identity. `replicaEpoch` identifies the physical tenant database and is
required; it is the only trustworthy proof that cached rows still describe the same database. An
epoch change MUST discard synced rows, pending mutations, collection state, and the saved cursor
before any cached row is served.

The replica's own bookkeeping tables are versioned, not migrated. A stored version that does not
match the running build MUST drop the bookkeeping tables and every synced row and catch up again;
restarting catch-up without the previous collection state would leave server-deleted rows resident
forever. Because the replica is a cache, this is always a safe answer and there is no per-column
migration ladder to keep correct.

An organization switch is a document boundary. The host changes the active organization only after
the target runtime is ready, then performs a full navigation. Pod MUST NOT remount a new organization
with modules imported for the previous organization.

## 3. Schema contract

`GET /_runtime/sync/schema` and the workspace bootstrap expose client-applicable DDL derived from the
live tenant database. The DDL contains only replica tables and columns; server-only constraints,
defaults, triggers, history tables, and internal tables are excluded.

Schema reconciliation MUST:

- preserve rows for additive tables and columns;
- drop and re-catch-up only a table whose table or column disappeared;
- preserve sync state for unaffected tables;
- never drop data when the target DDL cannot be parsed safely.

## 4. Collection residency and query completeness

The replication unit is a policy-scoped collection, not a query shape. The first catch-up page is
250 rows so a foreground read can render quickly. Remaining pages use batches of up to 5,000 and run
in the background.

The default encoded-row residency budget is 1 GiB across the replica. Collections are admitted in
demand order and charged by the approximate JSON byte size received from the server.

A collection is:

- `resident` when every row visible to the current policy scope is local;
- `windowed` when the residency budget stops catch-up before the visible collection is complete;
- `unsynced` while no trustworthy catch-up boundary has been reached.

The executor MUST use the following completeness rules:

| Read                                    | Resident | Windowed or unsynced |
| --------------------------------------- | -------- | -------------------- |
| `findMany` with filter/order/page       | local    | server               |
| `findFirst` primary-key hit             | local    | local                |
| `findFirst` miss or non-key predicate   | local    | server               |
| `count`                                 | local    | server               |
| search                                  | local    | server               |
| to-one relation with every key resolved | local    | local                |
| missing to-one or any to-many relation  | local    | server               |

A local row is always a real policy-scoped row, so a primary-key hit is complete even in a window.
Absence, counts, arbitrary ordering, and to-many sets cannot be proven from a window and MUST NOT be
presented as complete.

Server fallback answers MUST be absorbed into the replica. Repeating the same primary-key read after
absorption MUST not require the network.

Search semantics are identical in both execution tiers: case-insensitive literal substring matching
over searchable scalar fields and direct to-one related searchable fields. `%`, `_`, and `\` in user
input are literals. Residency MUST NOT change which records match a search.

## 5. Catch-up and cursor safety

`POST /_runtime/sync/shape` returns one keyset page:

```ts
type ShapeResponse = {
	rows: Record<string, unknown>[];
	nextCursor: string | null;
	watermark: string;
	cursor?: { xid: string; seq: string };
};
```

The server MUST capture the safe outbox watermark before reading the first page. A commit between
watermark and page read can then be applied twice, never lost; primary-key upsert makes replay
idempotent.

The client MUST stop catch-up when the server returns `nextCursor: null`, when the shared byte budget
is reached, or when an invalid empty page with a continuation cursor is received. Only the first two
are trustworthy completion boundaries. Catch-up MUST be bounded and MUST NOT spin on an empty page.

Persisted collection state MUST survive reload, but persisted residency proves completeness only at
its saved cursor. On document boot the client MUST read the safe server head and cross that sequence
on the ordered feed before serving restored rows locally. Until then, every restored-collection read
uses the authoritative server tier and absorbs its answer. A client that cannot establish the barrier
MUST stay server-first; it MUST NOT turn a stale primary-key hit or absence into a local answer.

Once the head barrier is crossed, a resident collection with a matching epoch MUST serve locally
without being downloaded again.

## 6. Live change feed

`GET /_runtime/sync/stream` is an SSE feed over the global `sync_outbox`. The durable resume cursor is
the pair `(xid, seq)`:

- `xid` orders transactions;
- `seq` orders rows within a transaction;
- rows MUST be emitted only below PostgreSQL's safe snapshot horizon;
- both cursor fields MUST advance atomically after local apply.

The client sends its subscribed collection names on the stream request. Interest is explicit: the
server MUST NOT resolve or emit contents for an unsubscribed collection, and an empty subscription
list therefore requests cursor progress only. The server MUST advance the global cursor across
unsubscribed rows without policy-reading or emitting record contents; an `event: cursor` control
frame persists that progress on the client, which is what keeps a command barrier able to settle
before the first collection is subscribed.

A newly subscribed collection MUST take effect on the feed, and the client rotates its connection to
apply it. Rotations SHOULD be coalesced: registering many collections in sequence must not spend the
warm-up disconnected. Nothing is lost by waiting, because the connection resumes from the durable
cursor and catch-up captures its own watermark.

For a subscribed create/update, the server re-reads the current row through the caller's policy. A
visible row becomes `insert` or `update`; an invisible or removed row becomes `leave`. A delete emits
`delete`. Forbidden row contents MUST never reach the client.

Diffs in one network chunk SHOULD be applied in bounded batches. Feed order MUST be preserved, and a
collection SHOULD notify live queries once per chunk rather than once per row.

The stream MUST reconnect after clean proxy closes and failures, with a bounded delay. An aborted or
failed stream reader MUST be cancelled so connections do not leak.

## 7. Visibility and reset protocol

Two events invalidate local assumptions:

- `event: reset` means the cursor is older than retained history. The client MUST discard the
  replica and resume from a fresh catch-up.
- `event: scope-reset` carries the safe cursor after a change to `policy`, `team`, `team_members`, or
  `user`. The client MUST discard policy-scoped rows, save the supplied cursor, rebuild request
  context, and re-catch-up active collections.

Approval releases use targeted visibility announcements for affected records. Broad authorization
changes use `scope-reset`; clients MUST NOT wait for a later page load to observe them.

An authenticated command that commits collection changes outside `sync/mutate` MUST return the
highest committed outbox sequence after its lifecycle hooks. The generated client MUST treat that
sequence as a read-your-command barrier: the command promise does not settle until the replica has
consumed the feed through that sequence. A bounded timeout MAY use one policy-scoped authoritative
point read for the command's root record; it MUST NOT report success while knowingly retaining the
pre-command root row. Approval decisions and withdrawals use this receipt contract.

The outbox is retained for seven days with a floor of 1,000 recent rows. Pruning MUST update the
durable compaction boundary in the same operation. A client behind the boundary MUST be reset rather
than resumed across a hole.

## 8. Mutations

The wire mutation is:

```ts
type WireMutation = {
	clientId: string;
	collection: string;
	action: 'create' | 'update' | 'delete';
	row?: Record<string, unknown>;
	version?: number;
};
```

Creates MUST receive a client-minted UUIDv7 before optimistic apply. The authoritative create path
MUST preserve that identity through before-hooks, making the optimistic key final. Updates and
deletes use the current local row version when available.

Before the request settles:

- create inserts the proposed row;
- update overlays proposed fields on the local snapshot;
- delete removes the row.

Confirmation overwrites the optimistic row with the complete committed row, including defaults,
hook output, timestamps, and version. Rejection restores the previous snapshot or removes an
optimistic create. A `CONFLICT` rejection includes `currentRow` for form reconciliation.

When offline or transport fails, the mutation MUST remain optimistic and be stored in `_pod_pending`
for ordered retry, together with the row it replaced. A retry MUST NOT re-derive its undo from the
replica, which already shows the mutation: a rejected queued delete would otherwise have nothing to
restore and would stay deleted locally forever. A settled retry MUST be removed from the queue. A
replica epoch or authorization scope reset MUST clear pending mutations because they were created
under invalid assumptions.

All server mutations MUST pass through `collection_ops`; direct collection-table writes remain
guarded by `_ops_guard`. Data, version/history, outbox, and approval state MUST commit atomically.

## 9. Author-facing query lifecycle

Live queries are keyed and shared by the runtime. A collection change re-evaluates queries for that
collection. This collection-level dependency is deliberate: it is conservative, deterministic, and
does not require authors to declare dependencies.

Internal resource invalidation is an implementation mechanism. The public contract is that tenant
components never call `invalidate`, `refetch`, or `revalidate` to keep collection data correct.

Loading means there is no trustworthy result to display. Once a query family has data, refreshes and
background catch-up MUST retain that data rather than replace it with an empty frame or spinner.

## 10. Acceptance matrix

Every normative area has a primary test owner:

| Contract                                                                  | Primary Pod coverage                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Local query compilation, completeness, relations, search                  | `tests/sync-engine/client-sync.test.ts`                                               |
| Catch-up, budget, persistence, cursor, optimistic writes, reset           | `tests/sync-engine/pod-sync-client.test.ts`, `subscription-registry.test.ts`          |
| SharedWorker bridge and replica isolation                                 | `tests/sync-engine/replica.test.ts`                                                   |
| Outbox ordering, horizon, co-commit, write guard                          | `tests/sync-engine/outbox-and-write-guard.test.ts`                                    |
| Compaction boundary and reset event                                       | `tests/sync-engine/sync-compaction-reset.test.ts`                                     |
| Policy-scoped runtime, mutation identity, multi-client convergence, scale | `tests/sync-engine/sync-e2e-comprehensive.test.ts`                                    |
| Real HTTP/SSE transport and cancellation                                  | `tests/sync-engine/sync-http-e2e.test.ts`                                             |
| Runtime schema and audit integration                                      | `tests/sync-engine/sync-runtime-contract.test.ts`                                     |
| Approval visibility, rollback, and command barrier                        | `tests/access-control/approval-announce-e2e.test.ts`, `approval-rollback-e2e.test.ts` |

Docker-backed suites are mandatory. Missing Docker or a failed runtime/template build MUST fail the
suite; it MUST NOT silently convert infrastructure coverage into skipped tests.
