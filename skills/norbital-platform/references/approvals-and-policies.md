# Source teams, policies and inline approvals

Access control is source configuration: teams link to policies, and policies declare grants
(the read outputs holders read and the rows of each, writes, state moves), manual starts,
capabilities, limits and inline approval configuration. Do not expose a runtime editor
for teams, policies or approval routes. A write becomes an approval request only through a source
grant's `check` returning `ctx.approve(...)`, never a runtime route object.

## Source homes

Policies use `src/access_control/policy/+<name>.policy.ts`. Teams belong under
`src/access_control/team/+team.ts`. The `team` declaration is an exact handle map: each entry is a
policy list or `{ name?, parent?, policies }`. Arrays use the handle as their display label. A
structured entry may supply a display name and source parent; the parent graph scopes `teamTree`
without inheriting policies or approval rights.

A policy filename supplies its name. Its declaration uses
`policy({ description, grants, automations?, capabilities?, limits? })`; grants name models.
Source team handles identify their policy links and approval routing. Members are runtime
identities affiliated with those source-defined teams through the native identity contract.

Do not seed runtime team or policy-assignment objects to emulate source declarations. Do not
substitute an unrelated database ID or a displayed member label for a source team handle.
The native `sys_team` catalogue is only a read-only generated projection preserving FK/query
compatibility; do not seed or edit it for authority. Runtime assignments are retired.
Changing source teams, policy links or approval configuration requires a source release.

## Grants and enforcement

Grants are layer maps typed from the model's own declaration. The model declares its read
outputs (`read` is `default`, `outputs` the named ones), each a fixed layer map. `read` grants the
`default` output and `outputs: { <name>: … }` named ones, each `true` or, per path of that output,
`{ where? }`: the root's `where` scopes the roots (it may hop relations), a deeper layer's `where`
filters that layer's rows (or nulls a ref) and never removes the root; a layer the grant does not
name is unfiltered. A policy never changes an output's fields: a narrower audience is granted a
narrower named output. `history` admits a scope. `create` and `update` are `true` or `{ columns?, check? }` with
`columns` per write path; `delete` is `true` or `{ check? }`. `moves` grants state transitions. The
policy's separate `automations` list grants manual starts (a person or the agent); code that
schedules needs none. An automation holds exactly its declared `policies`, with its starter as
`requestor`; an effect runs as its writer and holds no policy. Capabilities expose apps, tools,
MCP and skills; limits constrain use.

**Authority is per access point.** `read`, `create`, `update` and `delete` of a model are access
points guarded by that model's policies alone, every layer under them included. Reading
`orders.party` as a layer of `orders`, or writing `orders.lines` through an order, consults only
the `orders` grant; the `parties` and `order_lines` policies are never consulted on that path.
Reading `parties` directly is its own access point. A child's `transform` still runs as business
validation, not authority.

Every read names one output and uses native caller scope. An unreadable row does not exist to that
caller; a field outside the output cannot be filtered, sorted or aggregated. Every member reads
`sys_user` output `directory` (id, name). Relationship hops and outputs are enforced by the engine,
not a parallel matcher in template UI. An administrator is a native flag on an admitted staff
identity, not an invented role or source team label.

**Admission:** `columns` per path is checked before any guest code; a column outside it is refused
`forbidden`. Each admitting policy's `check` then judges the whole batch, nested layers included:
create trees, `{ before, set }` per update, the stored rows of a delete. It reads at most twice
through `ctx.db.query` as the workspace (a relation-hop scope is one keyed read) and performs no
writes or I/O. Any `ctx.allow()` executes normally without approval; otherwise the first
`ctx.approve(...)` in the team's policy order commits the write provisionally and opens an approval
request; otherwise the first `ctx.deny(message, { row, path, field })` refuses it. The provisional commit is an ordinary write: authored
input/reference validation, source ownership, parent ownership, state/sealing locks, revisions and
transaction atomicity all apply when it is submitted.

## Inline approval configuration

Declare approval as the `approve` verdict of the relevant source write grant's `check`:
`ctx.approve((flow) => flow.step(name, { teams?, users? }) …)`, with `if`/`else` and
`supersededBy`. Its routes, steps and supersession
refer to source team handles validated by the compiled contract. Do not add runtime route objects,
a required runtime configuration reference, template approver models or a second decision
engine. Use the selected source types for handles and inline route configuration. The routed write
is admitted against current native permissions and invariants when it is submitted; decisions do not
replay it. Verify native tests and the shared UI exercise the actual path.

Business lifecycle and approval are distinct. Use state for draft/active/closed and its edit rules;
do not duplicate native approval status in a business enum or add an approve transition as a
replacement for the framework request engine.

Source-route changes must not silently redirect a pending request: it keeps its route snapshot,
and its lock and `$approval` hold until it finishes, even when a release removes the route. A
rollback after a release skips and reports fields whose definition changed and models removed.
If a release removes the request's model or record, only an administrator's `CLOSED` move
ends it (Withdrawn, reason `source changed`). Test the final selected routing
semantics against source team links and current member affiliation. Hierarchy does not confer
another team's policies or decision right.

Use native member/team preview to probe roles. Preview keeps the selected source grants and
clears administrator bypass. Every decision rechecks the real preview administrator and the
selected source team or member. Revoking the administrator or removing the team must refuse a
stale preview; do not assign real membership to make a preview decision work.

## Requests, outcomes and shared controls

A routed write **commits at once** and its request holds it: `pendingApproval` carries the
`requestId` and the written records. The state machine (Bolt docs, "Approvals") is one table:

| From             | Native transition             | By                     | To                                   |
| ---------------- | ----------------------------- | ---------------------- | ------------------------------------ |
| Pending k/n      | `APPROVED`                    | step k's approvers     | Pending k+1, or Approved at the last |
| Pending          | `REJECTED`                    | step's approvers       | Rejected (rollback)                  |
| Pending          | `REQUEST_FOR_CHANGE` (reason) | step's approvers       | ChangesRequested (data stays)        |
| Pending          | `SUPERSEDED` (reason)         | admin / `supersededBy` | Superseded (change stands)           |
| ChangesRequested | `RESUBMITTED` (optional note) | requester              | Pending 1/n, the same request        |
| ChangesRequested | `REJECTED`                    | that step's approvers  | Rejected (rollback)                  |
| open             | `WITHDRAWN`                   | requester              | Withdrawn (rollback)                 |
| open             | `COMMENT` (text)              | any participant        | unchanged                            |
| open             | `CLOSED`                      | admin, source removed  | Withdrawn (rollback)                 |

Review decisions use `bolt.approvals.decide(requestId, { decision, reason? })`, with decision
`approve`, `reject` or `requestChanges`; the last two require a reason. The requester's next
ordinary Save resubmits requested changes. Shared review controls own the available native
transitions; render the view's `moves`, never infer eligibility yourself. Rollback restores every
held record to its checkpoint as `restored` history: updates restored, creates deleted, deletes
re-created. Skipped fields are reported in the log entry, never failing the decision. Derived
roll-ups are not restored. Finished requests stay. A record's approval history is all its
requests in order, each with its full log (`bolt.approvals.list({ model, records, all: true })`).

**The lock.** While a request is Pending or ChangesRequested, its held records and their owned
children change only through it: by the current approvers in Pending, and by the requester in
ChangesRequested. Every other writer is refused `locked` ("Under approval: <who> may change it"):
outsiders, administrators, automations, syncs, the agent, other models' guarded writes, cascades and
restore. Record capabilities report `underApproval`, so shared controls disable editing.
Outbound sends from a held record wait for approval.

**Reads.** Each read row a request holds carries
`$approval: { requestId, state, step, steps, requestedBy }`. Shared `Table` and `Board`
accent such rows with a tooltip; a custom list renders `row.$approval` itself. Use shared
`ApprovalPanel`, `ReviewBanner` or `RecordShell` for review. The record shell shows the full
timeline, with past requests collapsed. Approval views carry current source `teamNames`; display
them, while eligibility uses exact handles.

A model's inline `notify(event, ctx)` receives `kind: 'approval'` with move `request`, `approve`,
`reject`, `requestChanges`, `resubmit` or `supersede`, plus request, records, step, steps, done,
requester and approvers. Return notices with `to: ['requester', 'approvers']` or explicit
team/user/policy recipients as needed. Every recipient gets the in-app notice; optional `via`
conversation connections also deliver it to the member's handle there. Team/policy recipient meaning must follow the compiled
source access contract. Templates should not build separate approval inboxes, counters or runtime
team/policy editors. The native inbox follows submissions and successful request transitions,
including decisions from shared record panels or other sessions without an accompanying notice.
Verify its rows and eligible reviewer count advance without reloading the page.

## Evidence required after migration

Verify source team-to-policy links and all three verdict branches (allow, approve, deny),
member affiliation and hierarchy through native tests. Cover granted outputs, layer scope under the root's
policy, `columns` refusal before `check`, sealed and
source-owned fields, the lock on every write path, rejection rollback, request-for-change and
resubmit, and source changes during pending requests.
Assert persisted state and actual authority, then independently probe shared UI. Also inspect the
removed settings surfaces and routes to confirm there is no runtime team/policy editing path.
