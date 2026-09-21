# Large writes publish no change set

Status: defect, reproduced. Date: 2026-09-21.
Scope: `collections.write` change-set publication — the guest's commit/publish boundary and the
host fan-out that reads `response.changes`.

Source: `src/runtime/app.ts` (`BundleDispatch.run`), `src/runtime/collections/collections.ts`
(`syncCommit.publish`), `src/runtime/sync/sync.ts`; host side: Colony `notifyCommitted`.

---

## Symptom

A payroll run for a company with ~85 payslips is created, the write settles, the sheet closes —
and the row never appears in the runs table until the page is reloaded. A run for a 15-employee
company on the same build appears live within a second.

## Evidence (local stack, pinned 0.0.79 set, tenant `norbital_hr`)

| Write      | Request | Response body keys                                                                                             | Stream frame                  | Row live |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------- |
| Nihon (85) | 1.13 MB | `resolution, mutationId, schemaFingerprint, records` — **no `changes`**                                        | `updates: [], resets: []`     | no       |
| KDIT (15)  | 250 KB  | carries `changes: 361` (`work_days: 300, adhoc_requests: 37, leave_entries: 8, payroll_runs: 1, payslips: 15`) | `updates: [run row, index 0]` | yes      |

Same UI, same component, same protocol, same build; only the size of the write differs. The
client is correct: it re-runs `collections.count` when the pending write leaves the outbox, which
is why the footer count updates while the rows pane stays empty — the count is a query, the rows
came from a prefix that was never told anything changed.

The in-process e2e fixture host uses a small public seed, so the existing live-arrival test
(`tests/e2e/payroll-run-form.integration.test.ts`) passes and does not cover this.

## Where it goes wrong

For the large create, **both** the invoking client's stream frame and the command response carry
no changes: the guest settles the write without publishing a batch. `BundleDispatch.run` returns
the response unchanged when `emitted.length === 0`, so an empty `drainChanges` plus an undefined
`response.changes` produces exactly the observed body. The small create publishes normally, so the
drop happens on the write's own commit/publish path as a function of graph size — not in
`compactSyncChanges`, which has no size cap.

`Collections.write` is one transaction and one statement by design, so a size-dependent branch is
plausible; the next step is to instrument `Collections.mutateBrowser` →
`syncCommit.publish`/`captureFinal` for a large graph and find where the captured batch becomes
empty. The durable outcome (record-only) is correct by design, so a client cannot recover the
changes by replay; the affected browser only heals on reload or on a later query re-register.

## Acceptance

A create whose graph settles several thousand rows must deliver its prefix changes to every
registered query on the same stream, exactly as a small create does. A test at the payroll-run
size — a company with dozens of payslips — is the gate; the current fixture's small seed hides it.
