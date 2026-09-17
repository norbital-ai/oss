# Approvals and locking

Access and approvals are one system. An approval flow is attached to a **write grant**. When
policy routes a write to approval the engine commits the write **provisionally** under a hold and
opens the request in the same transaction. There is no separate "submit for approval" action.

Subjects and teams: [access](./README.md).

Source: `src/runtime/approvals/approvals.ts`, `src/runtime/collections/collections.ts`,
`src/authoring/approval-flow.ts`.

---

## Declaration

Attach `approval` to `mutate.new`, `mutate.existing`, or `delete` (gating a `read` is a compile
error):

```ts
grants: {
  variation_requests: {
    mutate: {
      new: {
        authorize: (context) => context.record.amount_total >= 1_000,
        approval: {
          flow: (context, api) =>
            api.requestor.team === 'Construction Sales' || context.record.amount_total < 5_000
              ? noApproval
              : approveBy('Field Operations Controllers').thenBy('Construction Leadership'),
          superceded_by: ['Construction Leadership']
        }
      }
    }
  }
}
```

`flow` is ordinary TypeScript. It returns `approveBy('Team').thenBy('Team')` or `noApproval`.
Teams listed in one stage are alternatives; stages are sequential (`thenBy`).
`superceded_by` names teams that may finish every remaining step. The chosen
`ApprovalConfiguration` is **snapshotted** into the request so a later release cannot restate it.

`authorize` on the same grant runs first; only explicit `true` passes. The whole batch of one
write shares one route; rows that route differently are refused and submitted separately.

There is no UI for editing a flow. Changing who approves is a source edit and a deploy.

---

## The machine

```text
                start: provisional commit + hold + restore point
                                   │
                                   ▼
   ┌────────────────────── ONGOING (step i) ──────────────────────┐
   │ step approved → i+1        participants may write, stamped  │
   │                                                              │
last step approved       request-changes / withdraw / reject   restore fails
   │                                    │                          │
   ▼                                    ▼                          ▼
APPROVED                 CHANGES_REQUESTED · WITHDRAWN · REJECTED   CONFLICTED
seal: clear stamps,        restore: every row back to its hold    held for an admin;
`committed` fires          snapshot, stamps cleared, `restore`    the restore is retried
                           revision appended                       or superseded
```

- **Start** is one transaction: the graph, the stamps, the restore point, the `bolt_approvals`
  row, the `approval_request` projection, its `requestor` link, and the `approvalStarted` /
  `approvalStepRequested` notification rows. The caller gets `pendingApproval: { requestId }`
  (a browser write settles as **202** `PendingApproval` — success, not a refusal).
- **The hold.** Every row the graph creates or updates carries `approval_id = requestId`; a row
  the graph deletes is gone, its snapshot kept. Each row gets one `hold` revision in
  `bolt_collection_history` carrying its full pre-image, or a null snapshot for a row the request
  created. Provisional values are real rows: sync pushes them, reports and automations see them,
  and `approval_id` (`where: { approval_id: { isNull: false } }`) is how a consumer tells them apart.
- **Writing under the hold.** A write that names a held row fails `ApprovalHeld { requestId }`
  before anything is written, unless the subject is a participant: the requestor, an approver of
  the current step, a team named in `superceded_by`, or an administrator. A participant's write
  goes through the same path as any other; its rows are stamped and hold-revisioned so a restore
  covers them, and one that would itself route to review rides the open request — nobody opens
  a second approval on a held row.
- **Step approved** advances the step. `SUPERSEDED` is an approval by a `superceded_by` team or an
  administrator that finishes every remaining step at once.
- **Seal** (`collections.resume`, dispatched as a task when the last step approves) clears the
  stamps on every locked collection in one statement, stamps `approval_request.applied_at`,
  publishes the change, and writes the `committed` and `approvalCompleted` notification rows. The
  values on the records are whatever the requestor and participants left there; nothing is
  re-applied.
- **Restore** (`collections.discard`, dispatched on request-changes, withdraw or reject) is
  record-level point-in-time recovery: the earliest `hold` snapshot of every row whose history
  carries the request's `approval_id` is loaded, then one transaction deletes rows born under the
  hold, rewrites every other row to its snapshot, re-inserts rows deleted in flight, clears the
  stamps and appends one `restore` revision per row. Every change made while the request was in
  flight, by anyone, is undone; the history keeps all of them.
- **Conflicted** is a restore that cannot apply (a foreign key from an unheld row now pointing at a
  row the restore must delete). The hold stays and the request is marked `CONFLICTED` for an
  administrator; `approvalConflicted` notification rules fire.

`api.collection_history.<name>.at(id, { before: requestId })` reads a record's restore point.

---

## Statuses

| Internal           | `approval_request.status` | Outcome                                                       |
| ------------------ | ------------------------- | ------------------------------------------------------------- |
| `Pending`          | `ONGOING`                 | The graph is committed provisionally; its rows are held       |
| `Approved`         | `APPROVED`                | `collections.resume` seals: stamps cleared, `committed` fires |
| `Rejected`         | `REJECTED`                | `collections.discard` restores every held row                 |
| `ChangesRequested` | `CHANGES_REQUESTED`       | Same restore; the requestor may resubmit                      |
| `Withdrawn`        | `WITHDRAWN`               | Requestor closed it while pending; same restore               |
| `Conflicted`       | `CONFLICTED`              | The restore could not apply; the hold stays                   |

Client `approvals.process` accepts `APPROVED` | `REJECTED` | `REQUEST_FOR_CHANGE` | `SUPERSEDED`.
`approvals.withdraw` is the requestor's own action.

Transitions are optimistic: `transitionQuery` updates state only if it is still `Pending`.

---

## Who may decide

A subject may act on a step only if **`teamPath[0]`** matches an approver on that step
(case-insensitive). Eligibility does **not** walk `teamPath`. A parent team does not inherit a
child's approval rights.

An administrator, or a team named in the snapshot's `superceded_by`, may **supersede**
(`supersedeCapability`) and finish remaining steps. That is not ordinary approve: approve still
requires `teamPath[0]` on the current step. Supersede and request-changes require a reason.
Static identities (envoy, automation, `colony-system`) have empty `teamPath` and **cannot
approve**.

---

## Where the state lives

| Artifact                            | Role                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `approval_id` on a row              | The open request holding it                                            |
| `bolt_collection_history` `hold`    | The row's restore point, tagged with the request                       |
| `bolt_approvals`                    | Durable FSM + the operation (root, requestor, resolved flow, lock set) |
| `approval_request`                  | Synced inbox: status, steps cursor, `applied_at`, who closed it        |
| `requestor`                         | Who raised it                                                          |
| `bolt_notifications` / `bolt_audit` | The collection's declared notices and the timeline                     |

`reconcileApproverTeams` inserts an empty `team` row for every `superceded_by` name that has none.
It does **not** auto-create flow-stage approver teams — those must exist via operator or
`+teams.ts`. A review-only team is a `+teams.ts` entry with an empty policy list.

The flow itself is not a table. It is the grant's live function; the snapshot carries **team
names**.

## Reads that validate a write

Reads a transform makes are fingerprinted with their result. Before committing, Bolt rechecks
those queries inside the write transaction under ordered table locks. A changed result refuses the
stale write and asks the caller to refresh and retry. Queries for unrelated records can still pass.
External calls are not repeated inside a database transaction.
