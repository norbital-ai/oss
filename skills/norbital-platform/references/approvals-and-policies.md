# Approvals and policies

Access control and approvals are one system, not two. An approval flow is something you attach to a
permission grant, so the question "may this person do this?" and the question "does this need
sign-off first?" are answered in the same place, from the same declaration.

## Policies

A policy is a named set of **grants** in `src/policies/+<name>.policy.ts`. A grant is an action on a
collection, optionally narrowed to matching rows:

```ts
{ collection: 'quotes', action: 'read', where: { owner_id: '${requestor.id}' } }
```

- Actions are `create`, `read`, `update`, `delete`.
- `where` narrows a grant to rows that match, so "read only your own quotes" is a grant rather than
  something the application has to remember to enforce.
- A policy also lists which apps it can reach.

Policies attach to **teams**, and users belong to teams. Which teams exist and who is in them is
runtime data; the policies themselves are source code and change by deploy.

Enforcement is at the data layer. Every read runs as the requestor, so it returns exactly the rows
that person could already see. If a query comes back empty, that is the requestor's access, not a
missing feature.

## Declaring an approval flow

Attach `approval` to a write grant. Only `create`, `update` and `delete` can be gated — gating a
`read` is refused at build time, because a silently dropped gate would leave an unconditional read
grant behind.

```ts
{
  collection: 'variation_requests',
  action: 'create',
  approval: {
    id: '019f6f10-0001-7000-8000-000000000003',
    name: 'Field operations variation approval',
    steps: [
      {
        id: '019f6f10-0001-7000-8000-000000000103',
        name: 'Field operations controller review',
        approvers: ['Field Operations Controllers'],
        description: 'Controller verifies scope change and selected photo evidence.'
      }
    ]
  }
}
```

Details that matter:

- **`approvers` holds team names, not ids.** They resolve to team ids when the workspace deploys, so
  the same declaration works on every tenant. A name that resolves to nothing is an error, not a
  silently ungated write.
- **Steps nest.** A step's own `steps` array is what runs after it. That is how multi-stage chains
  are built; there is no separate "stage" concept.
- **`supercededBy`** names teams that may close the whole flow outright.
- **`where`** on the flow, or on any step, narrows when it applies — evaluated against the mutation
  being gated.
- **`steps` and `approvers` must both be non-empty.** An empty step list resolves as
  already-approved, so the gate would be declared and then not exist. A step with no approvers can
  never be acted on and permanently wedges every write it gates.
- **The `id` values are permanent.** An in-flight request stores the step ids it is waiting on.
  Reissuing one strands the request against a step the config no longer has.

## Write-then-lock

Norbital does not hold a write and apply it after approval. It writes first and locks the row.

When a mutation matches a gated grant:

1. The row is written immediately.
2. The row is stamped with `norbital_approval_id`.
3. An `approval_request` record is created with status `ONGOING`.
4. Database triggers lock the row. Further writes to it fail with a conflict (HTTP 409) until the
   request closes.

So a pending row **is** in the table and will appear in queries. The convention across workspaces is
that `norbital_approval_id IS NULL` means the row is live and approved, and a non-null value means
it is held by an open approval. Reports and dashboards filter on that.

There is no separate "submit for approval" action. A gated write creates the request by itself.

## Statuses and outcomes

`approval_request.status` is one of `ONGOING`, `APPROVED`, `REJECTED`, `REQUEST_FOR_CHANGE`.

| Outcome                                 | What happens                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Approved                                | The stamp clears and the locks release. The data was already live.                                        |
| Rejected, or withdrawn by the requestor | The row is rolled back out of temporal history.                                                           |
| Request for change                      | Locks stay on. Only the original requestor may revise, and the revision re-evaluates policy from scratch. |

A user may act on a step only if they belong to one of that step's approver teams. Attempting
otherwise is refused with a message naming the teams that can.

## Where the state lives

| Table / column                                 | Holds                                                         |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `approval_request`                             | Status, the step tree, which records it locks, when it closed |
| `requestor`                                    | Links a request to the user who raised it                     |
| `policy.grants[].approval_config`              | The compiled flow, with team ids resolved                     |
| `norbital_approval_id` on every collection row | The stamp identifying the open request holding it             |
| `_approval_lock`                               | The materialised locks the database triggers enforce          |

The first four are system collections. Whether a given agent may read them depends on its
configuration, but they exist and this is where the answers are.

## A deployment ordering wrinkle

Migration runs before seeding, so on a brand-new tenant the approver teams do not exist yet and
every gate is stored with an empty approver list — blocked, but with nobody able to act. A second
reconcile pass after seeding binds the team names to ids. If approvals appear stuck on a freshly
provisioned environment with "no approvers" on every step, that pass did not run.

## What does not exist

There is no UI for building or editing an approval flow, and no admin screen that adds a step or
changes who approves. Adding, removing or re-routing a flow is an edit to a policy source file
followed by a deploy. When someone asks to add an approval step, that is the honest answer.
