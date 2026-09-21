# Large writes publish no change set

Status: fixed. Date: 2026-09-22. Fix: `settled-without-changes` writer reset in
`SyncConnectionLane.#pumpCommit` (`bolt-protocol`).
Scope: `collections.write` change-set publication — the guest's commit/publish boundary, the
browser-mutation ledger's replay path, and the host fan-out that reads `response.changes`.

Source: `src/runtime/app.ts` (`BundleDispatch.run`), `src/runtime/collections/collections.ts`
(`mutateBrowser`, `settleOutcome`), `src/runtime/sync/sync.ts`; host side: Colony
`notifyCommitted`, `bolt-protocol` `sync-registry.ts`.

---

## Symptom

A payroll run for a company with ~85 payslips is created, the write settles, the sheet closes —
and the row never appears in the runs table until the page is reloaded. A run for a 15-employee
company on the same build appears live within a second.

## Evidence (local stack, tenant `norbital_hr`, 2026-09-21)

| Write      | Response body keys                                                              | Stream frame                                                     | Row live |
| ---------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------- |
| Nihon (85) | `resolution, mutationId, schemaFingerprint, records` — **no `changes`**         | `updates: [], resets: [], outcomes: [accepted]`                   | no       |
| KDIT (15)  | carries `changes: 361` (`work_days: 300, adhoc_requests: 37, leave_entries: 8, payroll_runs: 1, payslips: 15`) | `updates: [run row, index 0]` | yes      |

## Where it goes wrong

Not the size of the graph. The observed response is the **replayed** shape: a second push for the
same idempotency key finds a terminal ledger row (`beginBrowserMutation` → `Replay`) and
`settleOutcome` answers with the durable outcome plus the post-commit readback. The ledger stores
the outcome, not the change set, so `changes` is absent — a first execution always carries the key,
even when the batch is empty.

The push still names its idempotency key (`mutationIdsFrom`), so the host runs
`sync.committed({ changes: [], pending: [id] })`. The guest answers outcomes only, and the writer's
frame was `updates: [], resets: [], outcomes: [accepted]`: the write promise resolved and the row
was durable, but no prefix was told to refetch. Reload healed it. A small write usually finishes
inside its first push and publishes its changes normally, which is why size looked causal — a
3,030-nested-create / 3,000-link-update test passes on the change-set path.

## Fix

`SyncConnectionLane.#pumpCommit` now resets the **writer's own attached prefixes**
(`settled-without-changes`) whenever a commit carries outcomes but no changes. The writer's
prefixes are the only state that can be stale in that settlement; nothing else on the stream has a
reason to refetch. The client drops the prefix and re-registers, so the written row appears live
instead of on reload. A rejected or pending-approval replay resets the same way — harmless, and it
keeps one rule: a settlement with no change set leaves its writer's queries fresh by re-registration.

## Acceptance

- A create whose graph settles several thousand rows delivers one change per row on the
  `collections.write` path (`collections-large-write-changes.integration.test.ts`).
- A replayed mutation's response carries no `changes` (`collections-wire-create.integration.test.ts`).
- A settlement carrying outcomes and no changes emits `resets: [settled-without-changes]` for the
  writer's attached prefixes and retires them (`bolt-server/tests/sync-host.test.ts`).
