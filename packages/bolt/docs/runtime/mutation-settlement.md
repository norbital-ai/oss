# Mutation settlement: bounding the wait

Status: Proposed. Date: 2026-09-21.
Scope: browser collection writes (`collections.write`), the durable idempotency ledger
(`bolt_browser_mutation`), and the client pending state that renders as "Saving…".

Source: `src/runtime/collections/collections.ts`, `packages/bolt-protocol/src/facilities.ts`,
`packages/bolt-server/src/facilities/database.ts`, `src/client/sync/client.ts`,
`src/client/mutation-settlement.ts`.

---

## 1. What happened

A payroll write on staging met a stalled server. The form read "Saving…" and stayed there;
re-tapping answered `425 mutation_in_progress`. The container was restarted and the write was
re-done. Nothing was lost — the transaction is all-or-nothing — but nothing in the product told
the person waiting whether to wait, retry, or reload, and no length of waiting resolved it.

## 2. The contract today

| Fact                                                                                                                         | Source                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| A push carries its own `idempotencyKey` and `issuedAtEpochMs`; the key is the dedupe, the timestamp is per attempt           | `bolt-protocol/src/collections.ts:46-70` |
| Before authored evaluation, the server commits a `running` claim under that key                                              | `collections.ts:1084-1157`               |
| The write transaction completes the claim in the same commit that makes the rows visible (`browserMutationClaimStatement`)   | `collections.ts:1357-1374`, `2950-2951`  |
| The claim's lease is `max(24h, 14d) + 5min` (~14 days); the row lives 21 days                                                | `collections.ts:281-303`, `1094-1096`    |
| A probe answers `425` with `retryAfterSeconds` while the lease is live; after it, the probe takes the claim over and re-runs | `collections.ts:1138-1156`               |
| The client re-pushes a write unanswered for 15s, but the driver issues at most one probe per 60s window                      | `machine.ts:30`; `client.ts:107,346-379`               |
| 4xx other than 408/425/429 is the only verdict; 425, 5xx and transport failure stay pending                                  | `mutation-settlement.ts:100-125`         |
| `retryAfterSeconds` rides the wire (`details.retryAfterSeconds`) and no client code reads it                                 | `runtime/app.ts:714-722`                 |

Two properties hold and must keep holding:

1. **Atomic settle.** A committed mutation and its terminal ledger row commit together, so a
   `running` claim means the mutation **did not commit** — retrying it is safe.
2. **Single writer.** The claim assert inside the write transaction is the last word, so a
   preempted or late evaluator can never commit after another one has.

## 3. The gap

One number, the lease, answers two different questions:

- _How long must a duplicate be refused?_ — the protocol retry window (24h; offline clients).
- _When is a silent evaluator provably gone?_ — a liveness bound, wanted in seconds.

Sizing it for the first leaves a crashed or hung evaluator parking the write for ~14 days.
Probes answer `425` with `retryAfterSeconds` up to 1,209,600, the client ignores that number and
probes every 60s, and the form cannot distinguish "in flight" from "server still evaluating".
The takeover after lease expiry does not help within a session, and it re-evaluates the mutation
on the probe, which is a second authored evaluation the contract otherwise avoids.

The comment at `collections.ts:1138-1139` claims "dispatch rejects the request as expired before
this lease can be taken over". No such check exists: the only expiry refusal is future clock skew
(`collections.ts:4832`), and the 24h horizon is used only to size the lease.

Separate note, out of scope here: a create carries no id (`bolt-protocol/src/collections.ts:56-60`),
so once a cleaned key is re-issued, re-evaluation is not obviously idempotent.

## 4. Requirements

1. Authored hooks are evaluated at most once for one key while its row lives.
2. A mutation commits at most once, and a late evaluator can never commit after preemption.
3. A live evaluator is never preempted.
4. A crash or restart resolves pending writes in seconds, not days.
5. A hung evaluator resolves within a configured deadline a person could wait out.
6. Committed outcomes stay replayable (21-day retention is unchanged).
7. Same behavior on Postgres and PGlite; no new dependencies.
8. Self-host keeps an escape hatch (deadline `0` = unlimited).

## 5. Design

### 5.1 The deadline is a property of the write transaction

`DatabaseRequest.Transaction` (`bolt-protocol/src/facilities.ts:10-27`) already sends one request
as one transaction (`bolt-server/src/facilities/database.ts:126-149`). Add an optional
`deadlineMs`; the binding opens the transaction with `set local statement_timeout = <ms>`
(PGlite: its own transaction monitor, same outcome) and lets the database abort it.

After the deadline, **no evaluator can commit that transaction**. A live-but-slow evaluator runs
inside the deadline; past it, its attempt is gone, and a fresh attempt is a new request. Default
`BOLT_SERVER_MUTATION_DEADLINE_SECONDS=300` so a twenty-second payroll build is untouched.

### 5.2 The claim records its owner and its deadline

Add to `bolt_browser_mutation`: `owner_instance text not null`, `deadline_at timestamptz not null`.

- `beginBrowserMutation` writes both at claim time.
- A `running` row with `deadline_at <= now()` is settled as a terminal `MutationRetryExpired`
  outcome and returned by the replay path. **No takeover re-evaluation on a probe** — the client
  re-submits under a fresh key if it still wants the write.
- `MutationInProgress` returns `retryAfterSeconds` derived from `deadline_at`, not from the lease.
- The lease stops being a liveness bound (it can remain as the duplicate-refusal ceiling).

### 5.3 Restart reconciliation

A one-row-per-process registry, `bolt_server_instance(instance_id, booted_at, heartbeat_at)`,
upserted at boot and heartbeated on a timer. Claims whose owner is absent or stale and whose
deadline has passed settle as `MutationRetryExpired`. On a single-writer host (one process per
tenant database) this degenerates to "owner instance is not this boot" and the registry can be
dropped — see open questions.

### 5.4 The client settles on the bound

- Honor `retryAfterSeconds` for the probe cadence, clamped to [5s, 120s].
- The form gains one state between "saving" and "settled": `evaluating`, entered when a push is
  answered 425. `425` is not a toast. `mutation_retry_expired` arrives as an ordinary refusal
  sentence and re-enables submit.
- The outbox, probe, and non-verdict rules (`mutation-settlement.ts`) are unchanged.

### 5.5 What does not change

Terminal replay within retention; `issuedAt` skew refusal; the in-transaction claim assert; the
probe's inability to double-evaluate (the assert still decides). `expired` is a terminal outcome
tag, not a ledger status, so the client's settlement vocabulary does not grow.

## 6. What the person sees

| Server state                     | Form                                                              | Submit   |
| -------------------------------- | ----------------------------------------------------------------- | -------- |
| Push in flight / queued          | Saving…                                                           | off      |
| `425`, deadline running          | Saving… still evaluating                                          | off      |
| Deadline passed or owner retired | "The write did not finish in time. Nothing was saved; try again." | on       |
| Committed or refused             | settled as today                                                  | as today |

## 7. Tests

- Evaluator dies between claim and commit: probe before deadline answers 425 with a
  deadline-derived `retryAfterSeconds`; after deadline the probe settles `mutation_retry_expired`;
  no row exists and no history was appended.
- Late evaluator: a transaction attempted after expiry fails the claim assert and rolls back.
- Restart: a running claim owned by a retired instance reconciles to `mutation_retry_expired` on
  boot or first probe.
- Deadline: a write slower than the configured deadline aborts with no rows; the same write with a
  fresh key succeeds. A 20-second payroll graph (the existing batching test) is unaffected.
- Client: `evaluating` on 425, settles on expiry, honors `retryAfterSeconds`, never double-submits.

## 8. Rollout

Additive protocol field, new columns, no tenant action and no reset. Order:
facility deadline → claim owner/deadline + expiry outcome → client `retryAfter`/`evaluating` →
restart reconciliation. The first two already bound the wait; the last makes restarts instant.

## 9. Open questions

1. **Single writer per tenant database?** If every host guarantees one serving process per tenant
   DB (Colony: verify), the boot id alone is sufficient and the instance registry is unnecessary.
2. Lazy expiry on the next claim/probe, or a background sweeper? There are no background jobs in
   `bolt-server`; lazy expiry costs one comparison on a path that already reads the row.
3. Default deadline and client clamp values.
4. Tombstones for cleaned keys, so a re-issued create after retention is refused rather than
   re-evaluated (out of scope; noted in §3).
