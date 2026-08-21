# Approvals and policies

Access control and approvals are one system, not two. An approval flow is something you attach to a
permission grant, so the question "may this person do this?" and the question "does this need
sign-off first?" are answered in the same place, from the same declaration.

## Policies

A policy is a named set of **grants** in `src/access/policies/+<name>.ts`. The filename supplies the
name; the module default-exports `{ description, grants, capabilities?, limits? }`. A grant is an
action on a collection, optionally narrowed to matching rows:

```ts
{ collection: 'quotes', action: 'read', where: { owner_id: '${requestor.norbital_id}' } }
```

- Actions are `create`, `read`, `update`, `delete`.
- `where` narrows a grant to rows that match, so "read only your own quotes" is a grant rather than
  something the application has to remember to enforce.
- `capabilities` grants apps, authored tools, MCP servers, and workspace skills. `limits` holds the
  rate rules for this policy's holders.
- **The filename is the only policy name.** `+sales_rep.ts` is `sales_rep`; do not restate `name`,
  `effect`, or `actions` in the object. The compiler derives those fields and generates the
  `PolicyName` union used by teams, envoys, and automations. The human-facing label is `description`.
- Combining a narrowed and an unconditional grant for the same collection/action would erase the
  narrowing, so the compiler refuses that unsafe composition.

## Teams hold policies; people belong to one team

There are **no roles**. A policy has a filename-derived name and nothing else selects it.

Three facts, and they are the whole model:

1. **A person belongs to exactly one team.** `bolt_auth_user.team_id` points at one `bolt_team` row.
   Not a set. A combination of authority that used to come from holding two roles at once has to be
   a _named team_ now — more verbose, and more honest, because every combination anybody actually
   holds appears in a diff.
2. **Which policies a team holds is declared in `src/access/+teams.ts`**, keyed by team name and valued by
   policy names, `satisfies Teams`. Team names are matched **case-insensitively** against
   `bolt_team.name` — one rule, everywhere.
3. **Membership is a row; authority is source.** An operator creates teams and moves people between
   them from a dashboard, without a deploy, because that changes constantly. What a team may _do_ is
   compiled into the release, because a row that granted a policy would be a privilege escalation
   performed with an `update` statement, in a place no diff and no type check can see.

The two halves are bound by name and they move independently at runtime:

- A `bolt_team` row whose name `+teams.ts` does not mention holds no policies. Inert, not broken —
  an operator may create a team before the code that gives it authority ships.
- Source cannot name a missing policy because the generated `PolicyName` union makes that a build
  error. A stale database team row remains inert until source declares authority for its name.

`teamPath` is the team and its descendants by `parent_id`, depth-ordered, and a subject holds the union
of the policies every team on that path declares. Note that **approval eligibility does not walk the
path** — see below.

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
    steps: [
      {
        key: 'controller_review',
        approvers: ['Field Operations Controllers'],
        description: 'Controller verifies scope change and selected photo evidence.'
      }
    ]
  }
}
```

Details that matter:

- **`approvers` entries and `bolt_team` names are the same string.** There is no id resolution and no
  separate approver registry: an entry is matched against the deciding subject's own team name,
  folded. `approvers` is generated `TeamName`, so misspellings fail the build. Declare review-only
  teams in `src/access/+teams.ts` with an empty policy list.
- **Activation creates the teams a step names.** On deploy, `reconcileApproverTeams` inserts an
  _empty_ `bolt_team` row for every `approvers` entry that has no row yet, guarded by a folded
  `not exists` so two spellings cannot mint two teams. It never refuses a release, and it logs each
  creation — so a name here that nobody expected is a typo in `approvers` showing itself at the one
  moment somebody is watching. An empty team is the correct thing to create: the name now resolves,
  the team appears in the settings surface, and putting somebody in it is one assignment away.
- **`steps` is flat.** An authored step carries `{ key, approvers, description? }` and runs in order.
  There is no nested `steps` array, no `supercededBy`, and no `where` on the flow or on a step.
- **`steps` and `approvers` must both be non-empty.** An empty step list resolves as
  already-approved, so the gate would be declared and then not exist. A step with no approvers can
  never be acted on and permanently wedges every write it gates.
- **Identity is derived, not authored.** The configuration id derives from
  `(policy, collection, action)` and each step id adds its stable `key`. Reordering steps is safe;
  changing a key changes the identity an in-flight request is waiting on.

## Write-then-lock

Norbital does not hold a write and apply it after approval. It writes first and locks the row.

When a mutation matches a gated grant:

1. **The hooks run and the row is written exactly as an ungated write would write it.** This order
   matters: the earlier design stored the _operation_ and wrote nothing, so the stored values were
   only what the form posted — a collection that derives six `not null` columns in
   `create.perRecord.before` produced an operation that could not satisfy its own schema when it was
   replayed, and its `after` hook never ran at all.
2. The row is stamped with `norbital_approval_id`, which is the lock.
3. An `approval_request` record is created with status `ONGOING`.
4. Any further write to that row is refused as an approval conflict naming the request that holds
   it, until the request closes.
5. The caller is answered **202** with `{ pending: true, requestId, collection, id, action }` — not
   a refusal. A tool or a screen that reports this as an error is reporting success as a failure.

So a pending row **is** in the table and will appear in queries. The convention across workspaces is
that `norbital_approval_id IS NULL` means the row is live and approved, and a non-null value means
it is held by an open approval. Reports and dashboards filter on that.

There is no separate "submit for approval" action. A gated write creates the request by itself. An
approval-gated collection is also never batched: `mutate` sends it down the one-row `create` path,
because a gate does not "write the batch" — it writes each row and holds each one under its own
request, which a reviewer has to decide on separately.

## Statuses and outcomes

`approval_request.status` is one of `ONGOING`, `APPROVED`, `REJECTED`, `WITHDRAWN`.

| Outcome                | What happens                                                                                                                                                                                                                                         |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approved               | The lock clears. For a create the row was already there, so approval releases it **and runs `create.perRecord.after` then** — that is what "approved" means for a created record. An update applies its stored values; a delete performs the delete. |
| Rejected, or withdrawn | For a create the row is deleted, because it only ever existed under the request. For an update or delete the lock is simply released and the record stands as it was.                                                                                |

There is no request-for-change flow. The client's `approvals.process` still accepts
`REQUEST_FOR_CHANGE` in its action union and does nothing with it — it issues no decision and
returns — so a surface that offers it as a button offers a button that silently does nothing. Treat
that union member as absent.

**Who may decide.** A subject may act on a step only if **their own team's name** is in that step's
`approvers`, matched case-insensitively. Eligibility does **not** walk `teamPath`: a parent team does
not inherit a child's approval rights, which is why a real flow lists every team that may decide a
step rather than only the nearest one. A step naming one team is decidable by that exact team and
nobody else, including every rung above it.

## Where the state lives

| Table / column                                 | Holds                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `approval_request`                             | Status, the steps, which record it holds, the operation to apply, when it closed |
| `requestor`                                    | Links a request to the user who raised it                                        |
| `norbital_approval_id` on every collection row | The stamp identifying the open request holding it — **this is the lock**         |
| `bolt_team`                                    | The teams themselves; `approvers` entries are matched against `name`             |
| `bolt_auth_user.team_id`                       | Which single team a person belongs to                                            |

The flow itself is not a separate table: it rides on the policy grant's own `approval` field, in the
compiled release, carrying **team names** — there is no `approval_config` with ids resolved into it,
and no `_approval_lock` table. Nothing is enforced by database triggers; the runtime checks the stamp
before it writes.

`approval_request` and `requestor` are system collections. Whether a subject may read them depends
on its policies, but they exist and this is where the answers are.

## Approver teams on a fresh tenant

Activation reconciles them. `reconcileApproverTeams` walks every `approvers` entry in the release and
inserts an **empty** `bolt_team` row for any name that has none, so on a brand-new tenant the teams
exist as soon as the workspace activates. It never refuses a release and never invents membership —
who is on a team is an operator's decision.

So the failure mode is no longer an unknown approver name; generated types reject that. It is a
declared team that exists and is **empty**. If an approval cannot be decided, look for a
`bolt_team` row with no members. The activation log names every team it created.

## What does not exist

There is no UI for building or editing an approval flow, and no admin screen that adds a step or
changes who approves. Adding, removing or re-routing a flow is an edit to a policy source file
followed by a deploy. When someone asks to add an approval step, that is the honest answer.
