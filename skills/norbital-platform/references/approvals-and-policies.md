# Teams, policies and approvals

Access control is source. Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').policy>[0]`, `Grant`, `ApprovalFlow`.

## Source homes

- A policy's filename supplies its name: `policy({ description, grants, capabilities?, limits? })`.
- `team(...)` maps exact handles to `{ policies, name?, parent? }`. Without `name`, the handle supplies its label. The parent graph scopes `requestor.team_tree` without inheriting policies or approval rights.
- Member identities select source handles. Never substitute a database ID or display label for a handle.
- Changing teams, links or routes needs a release.

## Grants

- A policy can grant only what the model declares: its outputs, paths and verbs. `bolt check` refuses the rest.
- `outputs: { default: …, <name>: … }` grants declared outputs. Each is `true` or a nested scope tree with `where` on its root or relation nodes. A root `where` scopes roots and may hop relations; a nested `where` filters that layer, or nulls a ref, never the root. An unnamed layer is unfiltered.
- A policy never changes an output's fields. A narrower audience gets a narrower output.
- An output grant with `history: true` admits history under that root's `where`; losing access to the row also loses its history. `create` and `update` are `true` or `{ columns?, verdict? }`; `delete` is `true` or `{ verdict? }`. Update `moves` grants state transitions.
- `capabilities.automations` grants manual starts by a person or the agent; code needs none.
- `capabilities.syncs` grants remote refreshes as `'<model>.<sync>'`; the model must also be readable. File controls use the native caller grants. Syncs are not automation starts.
- `capabilities` expose apps, including kiosk apps, tools and MCP. Declaring a server does not grant it.
- Authority is per access point. `read`, `create`, `update`, `delete` of a model are guarded by that model's policies alone, every layer included. A child's transform still validates; it is not authority.
- An unreadable row does not exist to the caller. A field outside the output cannot be filtered, sorted or aggregated.
- Every member reads `sys_user` output `directory`. A `sys_file` lister grants output `meta`.
- An automation holds exactly its `policies`; an effect runs as its writer.

## Admission

1. `columns` trees with `fields` at each node are checked before guest code; outside them is `forbidden`.
2. Each admitting policy's `verdict` judges changes with `before`, `set`, `after` and `changed(...)`; create has null `before`, delete has null `after`. It uses workspace `ctx.query`, prefetches before mapping and does no writes or I/O.
3. Any `ctx.allow()` executes. Else the first `ctx.approve(...)` in team policy order commits provisionally under a request. Refuse through `yield* ctx.refuse(message, { row, path, field })`.

A provisional commit is an ordinary write: validation, ownership, locks, revisions and atomicity apply. Its `with` rows are held with it; its `on_approved` rows commit in the approving decision, or the decision is refused and the request stays pending.

## Limits

- `limits` throttle per holder: `act`, `read`, `upload`, `convert`, `agent`, visitor `register`, envoy traffic. A bare rate counts per member, per IP for visitors; `{ rate, per: 'ip' }` only on a public audience's policy.
- Members default to `act 600/min`, `read 3000/min`, `upload 120/min`, `convert 30/min`, `agent 100/h`. Visitors per IP: `act 120/h`, `read 600/min`, `upload 20/h`, `register 20/h`.
- A refusal is `429 rate_limited` with `Retry-After`. Limits never apply to automation bodies.

## Approval flows

- `ctx.approve({ steps: [{ name, teams: ['<handle>'] }], superseded_by?: ['<handle>'] })`. Each authored step names a nonempty team list. Branch with ordinary code before returning the flow; there is no flow builder.
- Any listed approver decides a step; steps run in order.
- The flow is snapshotted on open and reevaluated on resubmit; changed steps restart at the first. A release never rewrites an open request's flow.
- No runtime route objects, template approver models or a second decision engine.
- State is business lifecycle; approval is separate. Never mirror approval in a business enum or add an approve transition.

## Requests

A routed write commits at once, held by its request; `pending_approval` carries `request_id` and records.

| State | Decision | Result |
| --- | --- | --- |
| Pending | `approve` by step approvers | next step, or Approved after the last |
| Pending | `reject` | Rejected: restore the checkpoint |
| Pending | `request_changes` | ChangesRequested: data stays |
| ChangesRequested | requester's Save | resubmits the same request |
| Open | authorized superseder approves with a reason | Superseded: data stays |
| Open | `withdraw` by the requester | Withdrawn: restore the checkpoint |

- `ctx.approvals.decide(id, { decision, reason? })`; reject and request_changes need a reason. Comments exist only as decision reasons. Render the view's `moves`; never infer eligibility.
- Only the requester withdraws an open request: the member who asked, or any run of the automation that asked through `ctx.approvals.withdraw(request_id, reason?)`. An approver rejects instead. Automations take no other decision.
- Rollback restores updates, deletes creates, re-creates deletes, as `restored` history. Missing fields are reported and skipped. Roll-ups follow their rows.
- Finished requests stay. `ctx.approvals.list({ model, records, all: true })` gives a record's history.
- The submitter cannot review their own request, even if named, on a reviewing team, an administrator, a linked envoy sender, or previewing. Others on the same team can.
- Resubmitting keeps the request pending even if policy would now allow directly.

## The lock

- While open, held records and owned children change only through the request: current approvers while Pending, the requester in ChangesRequested. Every other writer is refused `locked`, including administrators, automations, syncs, the agent, cascades and restore. Outbound sync writes wait for approval.
- A pending request keeps its snapshot and lock through releases.
- Each held read row carries `$approval: { request_id, state, step, steps, requested_by }`. Use the shared approval panel and `RecordShell`. Display `team_names`; eligibility uses handles.
- The verb's effect gets `ctx.event.kind === 'approval'` with move `request`, `approve`, `reject`, `request_changes`, `resubmit`, `supersede` or `withdraw` and no committed changes. Use `ctx.notify` for custom notices; recipients may be `requester`, `approvers`, teams, users or policies. Built-in inbox notices and counters already exist.

## Preview and evidence

- Member and team preview keeps selected source grants and clears administrator bypass; each decision rechecks the real administrator and selected identity. Never assign real membership to make a preview work.
- Verify the three verdicts, member affiliation and hierarchy, granted outputs, layer scope, `columns` refusal before `verdict`, the lock on every path, rollback, resubmit and releases during pending requests. Assert persisted state.
