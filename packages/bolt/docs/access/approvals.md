# Approvals and locking

Access and approvals are one system. An approval flow is attached to a **write grant**. The
runtime prepares the mutation before it asks for approval; it does not publish proposed values
while review is open. There is no separate "submit for approval" action.

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

`authorize` on the same grant runs first; only explicit `true` passes.

There is no UI for editing a flow. Changing who approves is a source edit and a deploy.

---

## Prepare, gate, commit, settle

Every `mutate` / `delete` path, including an agent's `write_collection` and a browser's
`collections.mutate` graph, uses the same lifecycle. `mutate.new` governs new rows and
`mutate.existing` governs existing rows:

1. **PREPARE** runs the applicable hooks and reconciles the proposed mutation graph without
   publishing its domain values.
2. The approval **gate** chooses `noApproval` or a concrete review flow.
3. `noApproval` proceeds to **COMMIT**. A gated mutation is put on **hold** instead.
4. **SETTLE** runs after commit. Approving a held request calls `collections.resume`, which commits
   the prepared mutation and settles it; rejecting or withdrawing discards it.

A held new-row mutation has **no domain row**. A held existing-row mutation or delete may stamp the
existing row with `approval_id` to prevent conflicting edits, but the proposed values or deletion
have not been applied.

On hold:

1. `bolt_approvals` row: `_tag: Pending`, embedded operation + configuration.
2. `approval_request` projection (`status: ONGOING`) and a `requestor` link.
3. For an existing-row mutation or delete target, `approval_id = requestId` may hold the committed
   row. A new-row mutation has no target row to stamp.
4. Caller gets **202** `{ pending: true, requestId, collection, id, action }` — success, not a
   refusal.

Further writes to that row are refused as an approval conflict until the request closes. There are
no database triggers; the runtime checks the stamp before it writes.

Convention: `approval_id IS NULL` means an existing row is not held; a non-null value identifies
the open request holding its committed state.

Server hooks and remotes can read held candidates with
`api.db.<collection>.findPending({ where, limit })`. These are partial candidate rows under the
target collection's read predicate and field mask, with `id` and `approval_id`; they do not expose
approval inbox metadata. Use this for reservations that must include requests submitted by another
person. Ordinary `findMany` still returns committed rows. The candidate read includes approved
requests until the mutation transaction stamps `approval_request.applied_at`, and excludes rejected,
withdrawn and applied requests. Merge candidates by record ID and exclude the hook's `recordId`
when validating that same request again during approval replay.

Browser views use `client.pending.findMany(collectionName, { where, limit })` for the same
policy-scoped candidates as a live query. It accepts a fixed scope of at most 2,000 proposals,
ordered by target record ID; narrow the scope instead of paging a reservation total. Generated
domain fields may be absent until approval applies the mutation. Approval transitions publish
their committed projection changes, and this read observes those changes without granting inbox
access. Ordinary command invocations remain one-shot; a derived calculation can depend on the
live candidate rows and committed row versions before invoking its read handler again.

Decision and withdrawal commands send only `{ state: { requestId }, ... }`. The server loads the
durable state and checks authority; the client never needs to upload the review snapshot again.

---

## Statuses

| Internal           | `approval_request.status` | Outcome                                                                          |
| ------------------ | ------------------------- | -------------------------------------------------------------------------------- |
| `Pending`          | `ONGOING`                 | Prepared values are held; existing targets are locked against conflicting writes |
| `Approved`         | `APPROVED`                | `collections.resume` commits the prepared mutation/delete and settles it         |
| `Rejected`         | `REJECTED`                | The prepared mutation is discarded; any existing-row lock is released            |
| `ChangesRequested` | `CHANGES_REQUESTED`       | Same as reject; requestor may resubmit                                           |
| `Conflicted`       | `CONFLICTED`              | Reviewed graph could not apply                                                   |
| `Withdrawn`        | `WITHDRAWN`               | Requestor closed it while pending                                                |

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
| `approval_id` on an existing row    | The open request holding its current committed state             |
| `bolt_approvals`                    | Durable FSM + full operation (`sync: false`)                     |
| `approval_request`                  | Synced inbox: status, steps cursor, proposed values, locked refs |
| `requestor`                         | Who raised it                                                    |
| `bolt_notifications` / `bolt_audit` | Decision notices and timeline                                    |

`reconcileApproverTeams` inserts an empty `team` row for every `superceded_by` name that has none.
It does **not** auto-create flow-stage approver teams — those must exist via operator or
`+teams.ts`. A review-only team is a `+teams.ts` entry with an empty policy list.

The flow itself is not a table. It is the grant's live function; the snapshot carries **team
names**.

## Reads that validate a write

Database reads made during hook preparation are fingerprinted with their result. Before committing
or reserving an approval, Bolt rechecks those queries inside the write transaction under ordered
table locks. A changed result, including a new matching row or pending proposal, refuses the stale
write and asks the caller to refresh and retry. Queries for unrelated records can still pass.
External calls are not repeated inside a database transaction. This protects concurrent mutations;
a hook that accepts a batch must also validate the combined effect of its inputs.
