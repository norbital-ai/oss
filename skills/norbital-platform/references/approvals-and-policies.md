# Teams, policies and approvals

Access control is source. Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').policy>[0]`, `Grant`, `Flow`.

## Source homes

- A policy's filename supplies its name: `policy({ description, grants, automations?, capabilities?, limits? })`.
- `team(...)` maps exact handles to a policy list or `{ name?, parent?, policies }`. A list uses the handle as its label. The parent graph scopes `teamTree` without inheriting policies or approval rights.
- Member identities select source handles. Never substitute a database ID or display label for a handle.
- Changing teams, links or routes needs a release.

## Grants

- A policy can grant only what the model declares: its outputs, paths and verbs. `bolt check` refuses the rest.
- `read` grants the `default` output; `outputs: { <name>: … }` the named ones; each is `true` or `{ where }` per path. A root `where` scopes roots and may hop relations; a deeper `where` filters that layer, or nulls a ref, never the root. An unnamed layer is unfiltered.
- A policy never changes an output's fields. A narrower audience gets a narrower output.
- `history` admits a scope. `create` and `update` are `true` or `{ columns?, check? }`; `delete` is `true` or `{ check? }`. `moves` grants state transitions.
- `automations` grants manual starts by a person or the agent; code needs none.
- `capabilities` expose apps, kiosks, tools and MCP. Declaring a server does not grant it.
- Authority is per access point. `read`, `create`, `update`, `delete` of a model are guarded by that model's policies alone, every layer included. A child's transform still validates; it is not authority.
- An unreadable row does not exist to the caller. A field outside the output cannot be filtered, sorted or aggregated.
- Every member reads `sys_user` output `directory`. A `sys_file` lister grants output `meta`.
- An automation holds exactly its `policies`; an effect runs as its writer.

## Admission

1. `columns` per path are checked before guest code; outside them is `forbidden`.
2. Each admitting policy's `check` judges the batch: create trees, `{ before, set }` per update, stored rows of a delete. It reads at most twice through `ctx.db.query` and does no writes or I/O.
3. Any `ctx.allow()` executes. Else the first `ctx.approve(...)` in team policy order commits provisionally under a request. Else the first `ctx.deny(message, { row, path, field })` refuses.

A provisional commit is an ordinary write: validation, ownership, locks, revisions and atomicity apply. Its `with` rows are held with it; its `onApproved` rows commit in the approving decision, or the decision is refused and the request stays pending.

## Limits

- `limits` throttle per holder: `act`, `read`, `upload`, `convert`, `agent`, visitor `register`, envoy traffic. A bare rate counts per member, per IP for visitors; `{ rate, per: 'ip' }` only on a public audience's policy.
- Members default to `act 600/min`, `read 3000/min`, `upload 120/min`, `convert 30/min`, `agent 100/h`. Visitors per IP: `act 120/h`, `read 600/min`, `upload 20/h`, `register 20/h`.
- A refusal is `429 rateLimited` with `Retry-After`. Limits never apply to automation bodies.

## Approval flows

- `ctx.approve((flow) => flow.step(name, { teams?, users? }) …)`, with `if`, `else`, `allow`, `deny` and `supersededBy`.
- Any listed approver decides a step; steps run in order.
- The flow is snapshotted on open and reevaluated on resubmit; changed steps restart at the first. A release never rewrites an open request's flow.
- No runtime route objects, template approver models or a second decision engine.
- State is business lifecycle; approval is separate. Never mirror approval in a business enum or add an approve transition.

## Requests

A routed write commits at once, held by its request; `pendingApproval` carries `requestId` and records.

| State | Decision | Result |
| --- | --- | --- |
| Ongoing | `approve` by step approvers | next step, or Approved after the last |
| Ongoing | `reject` | Rejected: restore the checkpoint |
| Ongoing | `requestChanges` | ChangesRequested: data stays |
| ChangesRequested | requester's Save | resubmits the same request |
| Open | authorized superseder approves with a reason | Superseded: data stays |

- `bolt.approvals.decide(id, { decision, reason? })`; reject and requestChanges need a reason. Comments exist only as decision reasons. A requester cannot withdraw. Render the view's `moves`; never infer eligibility.
- Rollback restores updates, deletes creates, re-creates deletes, as `restored` history. Missing fields are reported and skipped. Roll-ups follow their rows.
- Finished requests stay. `bolt.approvals.list({ model, records, all: true })` gives a record's history.
- The submitter cannot review their own request, even if named, on a reviewing team, an administrator, a linked envoy sender, or previewing. Others on the same team can.
- Resubmitting keeps the request pending even if policy would now allow directly.

## The lock

- While open, held records and owned children change only through the request: current approvers while Ongoing, the requester in ChangesRequested. Every other writer is refused `locked`, including administrators, automations, syncs, the agent, cascades and restore. Outbound sends wait for approval.
- A pending request keeps its snapshot and lock through releases.
- Each held read row carries `$approval: { requestId, state, step, steps, requestedBy, waitingOn }`. Views accent it; a custom list renders it. Use the shared approval panel and `RecordShell`. Display `teamNames`; eligibility uses handles.
- `notify` gets `kind: 'approval'` with move `request`, `approve`, `reject`, `requestChanges`, `resubmit` or `supersede`; `to` may hold `requester`, `approvers`, teams, users, policies. Never build separate inboxes or counters.

## Preview and evidence

- Member and team preview keeps selected source grants and clears administrator bypass; each decision rechecks the real administrator and selected identity. Never assign real membership to make a preview work.
- Verify the three verdicts, member affiliation and hierarchy, granted outputs, layer scope, `columns` refusal before `check`, the lock on every path, rollback, resubmit and releases during pending requests. Assert persisted state.
