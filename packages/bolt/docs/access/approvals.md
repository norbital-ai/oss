# Approvals and locking

Access and approvals are one system. An approval flow is attached to a **write grant**. The
runtime writes the row, then locks it. There is no separate "submit for approval" action.

Subjects and teams: [access](./README.md).

Source: `src/runtime/approvals/approvals.ts`, `src/runtime/collections/collections.ts`,
`src/authoring/approval-flow.ts`.

---

## Declaration

Attach `approval` to `create` / `update` / `delete` (gating a `read` is a compile error):

```ts
grants: {
  variation_requests: {
    create: {
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
```

`flow` is ordinary TypeScript. It returns `approveBy('Team').thenBy('Team')` or `noApproval`.
Teams listed in one stage are alternatives; stages are sequential (`thenBy`).
`superceded_by` names teams that may finish every remaining step. The chosen
`ApprovalConfiguration` is **snapshotted** into the request so a later release cannot restate it.

`authorize` on the same grant runs first; only explicit `true` passes.

There is no UI for editing a flow. Changing who approves is a source edit and a deploy.

---

## Write-then-lock

**Imperative** (`create` / `update` / `delete`, including an agent's `write_collection`):

1. Hooks run; the row is written as an ungated write would write it.
2. `holdForApproval` stamps `approval_id` — **this is the lock**.

This order is load-bearing. An earlier design stored the operation and wrote nothing, so values
derived in `create.perRecord.before` were missing on replay and `after` never ran.

**Declarative** (`collections.mutate` graph): the graph is reconciled **before** any part is
written. A declarative create is the one lockless case — the domain row does not exist until
approval. Rejecting it is already atomic cleanup.

On hold:

1. `bolt_approvals` row: `_tag: Pending`, embedded operation + configuration.
2. `approval_request` projection (`status: ONGOING`) and a `requestor` link.
3. Unless declarative create: `approval_id = requestId` on the target row.
4. Caller gets **202** `{ pending: true, requestId, collection, id, action }` — success, not a
   refusal.

Further writes to that row are refused as an approval conflict until the request closes. There are
no database triggers; the runtime checks the stamp before it writes.

Convention: `approval_id IS NULL` means the row is live; a non-null value means it is held.

---

## Statuses

| Internal           | `approval_request.status` | Outcome                                                                               |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------- |
| `Pending`          | `ONGOING`                 | Locked; further writes refused                                                        |
| `Approved`         | `APPROVED`                | `collections.resume` — create's `after` hook runs now; update/delete apply            |
| `Rejected`         | `REJECTED`                | `collections.discard` — provisional create deleted; update/delete only clear the lock |
| `ChangesRequested` | `CHANGES_REQUESTED`       | Same as reject; requestor may resubmit                                                |
| `Conflicted`       | `CONFLICTED`              | Reviewed graph could not apply                                                        |
| `Withdrawn`        | `WITHDRAWN`               | Requestor closed it while pending                                                     |

Client `approvals.process` accepts `APPROVED` | `REJECTED` | `REQUEST_FOR_CHANGE` | `SUPERSEDED`.
`approvals.withdraw` is the requestor's own action.

Transitions are optimistic: `transitionQuery` updates state only if it is still `Pending`. Lock
release sets `approval_id = null` where `approval_id = requestId`.

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

| Artifact                            | Role                                                             |
| ----------------------------------- | ---------------------------------------------------------------- |
| `approval_id` on every row          | The lock                                                         |
| `bolt_approvals`                    | Durable FSM + full operation (`sync: false`)                     |
| `approval_request`                  | Synced inbox: status, steps cursor, proposed values, locked refs |
| `requestor`                         | Who raised it                                                    |
| `bolt_notifications` / `bolt_audit` | Decision notices and timeline                                    |

`reconcileApproverTeams` inserts an empty `team` row for every `superceded_by` name that has none.
It does **not** auto-create flow-stage approver teams — those must exist via operator or
`+teams.ts`. A review-only team is a `+teams.ts` entry with an empty policy list.

The flow itself is not a table. It is the grant's live function; the snapshot carries **team
names**.
