# Teams, policies and approvals

Access control is source. Exact shapes: `Parameters<typeof import('@norbital-ai/bolt').policy>[0]`, `ApprovalFlow`.

## Source homes & grants

- `policy({ description, grants, capabilities? })` (filename = name). Teams are `sys_team` rows an administrator edits (`name`, optional `parent`, `policies`); source declares none and holds a team only as an `Id<'sys_team'>` read from a row. Parent graph scopes `actor.team_tree` without inheriting policies or approval rights. Changing policies/routes requires a release; a team's policies change with its row, on the next request.
- Policies grant only declared model outputs/verbs (`bolt check` refuses others). `outputs: { default: …, <name>: … }` takes nested `{ where?, history?, <relation>?: { where? } }` trees (`{}` = all rows). Policies filter rows, never shape — narrower audiences get narrower outputs.
- `history: true` grants history under the root `where` (losing row access loses history). `create`/`update` take `{ fields?, <relation>?, verdict? }` (`{}` = all declared fields; no `true` shorthand); `update.moves` grants state transitions; `delete` takes `{ verdict? }`.
- `capabilities`: `automations` (manual starts by person/agent; code needs none), `syncs` (`'<model>.<sync>'` remote refreshes; model must be readable), `apps` (including kiosks), `tools`, `mcp`, and `personal_connections` (personal integration definitions a member may connect and manage at `/connections` or via `<Connections />`).
- Authority is per access point on the root model's policies (including nested layers). Unreadable rows do not exist; hidden fields cannot be filtered, sorted or aggregated. Every member reads `sys_user` (`directory`); `sys_file` listers grant `meta`. Automations hold only their `policies`; effects run as their writer.

## Admission & limits

1. Write `fields` trees check before guest code (`forbidden` if outside).
2. Each admitting policy's `verdict` inspects `{ before, set, after, changed }` (workspace `ctx.query`, prefetch before mapping, no writes/I/O).
3. Any `ctx.allow()` executes; else first `ctx.approve(...)` in team policy order commits provisionally; refusals use `yield* ctx.refuse('<catalogue key>', { row?, field?, values? })`.
4. Provisional commits validate normally: `with` rows are held/rolled back with the root; `on_approved` rows commit atomically on final approval (if that fails, request stays pending).

`+workspace.ts` `limits: { <policy>: { … } }` throttle holders (`act`, `read`, `upload`, `convert`, `agent`, visitor `register`, envoy; `{ rate, per: 'ip' }` for public policies only). Defaults: members `act 600/min`, `read 3000/min`, `upload 120/min`, `convert 30/min`, `agent 100/h`; visitors/IP `act 120/h`, `read 600/min`, `upload 20/h`, `register 20/h`. Exceeded → `429 rate_limited` + `Retry-After`. Never throttles automation bodies.

## Approval flows & requests

- `ctx.approve({ steps: [{ name, teams?: [<sys_team id>], users?: [<sys_user id>] }], superseded_by?: [<sys_team id>] })`; a step names teams, users or both, each an id the verdict reads from a row (a record's reviewing team or assigned approver: `teams: [row.review_team]`, `users: [row.approver_id]`). Branch in code; no runtime route models or second decision engine. Approval is a separate lock, never a business state named `approved`.
- Flows snapshot on open (releases never rewrite open flows) and re-evaluate on resubmit (changed steps restart at step 1). Steps run in order; any listed team member or user decides.
- Held writes return `pending_approval` (`request_id`, `records`). Submitters cannot review their own requests (even if admin or on the team). Resubmitting keeps the request pending even if policy now allows directly.

| State | Decision | Result |
| --- | --- | --- |
| Pending | `approve` (step approver) | next step, or Approved after last |
| Pending | `reject` (reason required) | Rejected; checkpoint restored |
| Pending | `request_changes` (reason required) | ChangesRequested; data stays |
| ChangesRequested | requester Save | resubmits same request |
| Open | superseder approves (reason required) | Superseded; data stays |
| Open | requester `withdraw` (page only) | Withdrawn; checkpoint restored |

- `ctx.approvals.decide(id, { decision, reason? })` (members on pages only; automations/effects never decide; render `moves` instead of inferring eligibility). A pending step with no active eligible approver besides the requester surfaces as `stalled: true` in `ApprovalView` and the approval panel so an administrator can add an approver to the team or close the request. Finished requests stay (`ctx.approvals.list`).
- Held deletes commit only the request (rows remain with `$approval.pending_delete`); final approval re-runs transform with `ctx.approving` and deletes rows + `with`/`on_approved` atomically. Rollback writes `restored` revisions.

## Lock, effects & verification

- While open, held records and owned children accept changes only from current approvers (`Pending`) or requester (`ChangesRequested`); all others fail `locked` (admins, automations, syncs, agent, cascades, restore). Outbound sync waits for approval.
- Held rows carry `$approval: { request_id, state, step, steps, requested_by }`; reuse native approval panel and `RecordShell`.
- Verb `effect` fires with empty changes and `ctx.event.kind === 'approval'` on `request`, `resubmit`, final `approve` and `supersede` (not intermediate steps/`request_changes`/`reject`/`withdraw`). Use `ctx.notify` for custom notices.
- Member/team preview clears admin bypass; test all 3 verdicts, affiliation/hierarchy, field refusals, locks on every path, rollback, resubmit and releases during pending requests.
