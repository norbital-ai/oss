# Approvals and policies

Access control and approvals are one system, not two. An approval flow is something you attach to a
permission grant, so the question "may this person do this?" and the question "does this need
sign-off first?" are answered in the same place, from the same declaration.

## Policies

A policy is a named set of **grants** in `src/access/policies/+<name>.ts`. The filename supplies the
name; the module default-exports `{ description, grants, capabilities?, limits? }`. `grants` is an
object keyed by collection, one key per collection/action coordinate — presence is the rule, absence
is denial, and there is no merge order to misunderstand:

```ts
import type { Policy } from './$types.js';

export default {
	description: 'A sales representative, scoped to their own quotes.',
	grants: {
		quotes: {
			read: { where: { owner_id: { eq: '${requestor.id}' } } },
			create: {}
		}
	},
	capabilities: { apps: ['crm'], tools: ['quote_followup'], skills: ['quote_basics'] },
	limits: {
		'collections.*': { window: '1 min', limit: 60 },
		'agents.turn': { window: '1 hour', limit: 100 }
	}
} satisfies Policy;
```

- Read-shaped actions are `read` and `history`; write actions are `create`, `update`, `delete`.
  `read`/`history` take `{ where?, fields? }` (a read grant has no approval to carry — nobody signs
  off on somebody having looked). Write grants take `{ fields?, authorize?, approval? }`; `delete`
  takes `{ authorize?, approval? }`.
- `where` narrows a read/history grant to rows that match, so "read only your own quotes" is a grant
  rather than something the application has to remember to enforce. `fields` masks which columns the
  grant exposes.
- `authorize` is a server-only decision function — `(context, api) => boolean` running in the write
  path, with reads and nothing else (`api.db.<collection>` without `mutate`), over the prepared
  candidate. The action key itself is the opt-in: an empty object means every prepared candidate,
  and an absent key means no authority for it.
- `capabilities` grants apps, authored tools, MCP servers, and workspace skills. `limits` holds the
  rate rules for this policy's holders, keyed by command pattern (exact command or `prefix.*`
  wildcard; the most specific match wins). Each rule is `{ window, limit }` — the `key` defaults to
  `subject` on a policy — where `window` is `'1 min'`-style and `key` is `subject`/`sender`/`tenant`
  (the anonymous half, `address`, lives in `src/access/+anonymous_limits.ts` and is the only
  separate rate-limit file).
- **The filename is the only policy name.** `+sales_rep.ts` is `sales_rep`; do not restate `name`
  (or an `effect`/`actions` list) in the object. The compiler reads the name off the file and
  generates the `PolicyName` union used by teams, envoys, and automations. The human-facing label is
  `description`. A restated `name:` is precisely what let five workspaces ship a display-cased
  string that compiled and matched nothing.

Enforcement is at the data layer. Every read runs as the requestor, so it returns exactly the rows
that person could already see. If a query comes back empty, that is the requestor's access, not a
missing feature.

## Teams hold policies; people belong to one team

There are **no roles**. A policy has a filename-derived name and nothing else selects it.

Three facts, and they are the whole model:

1. **A person belongs to exactly one team.** `user.team_id` points at one `team` row. Not a set.
   A combination of authority that used to come from holding two roles at once has to be a _named
   team_ now — more verbose, and more honest, because every combination anybody actually holds
   appears in a diff. (Administration is `user.status = 'admin'`, a status on the person, not a
   role and not a team.)
2. **Which policies a team holds is declared in `src/access/+teams.ts`**, keyed by team name and
   valued by policy names, `satisfies Teams`. Team names are matched **case-insensitively** against
   `team.name` — one rule, everywhere, and the unique index enforces it.
3. **Membership is a row; authority is source.** An operator creates teams and moves people between
   them from a dashboard, without a deploy, because that changes constantly. What a team may _do_ is
   compiled into the release, because a row that granted a policy would be a privilege escalation
   performed with an `update` statement, in a place no diff and no type check can see.

The two halves are bound by name and they move independently at runtime:

- A `team` row whose name `+teams.ts` does not mention holds no policies. Inert, not broken —
  an operator may create a team before the code that gives it authority ships.
- Source cannot name a missing policy because the generated `PolicyName` union makes that a build
  error. A stale database team row remains inert until source declares authority for its name.

`teamPath` is the subject's own team first, then its descendants by `parent_id`, depth-ordered. The
path is for **row scope**: a subject's _authority_ is what their own team (`teamPath[0]`) declares —
descendants stay in the path for row predicates but confer no policies, otherwise a database
hierarchy edit could compose policies that no reviewed `+teams.ts` entry names. Approval eligibility
uses the same one team, never the path — see below. Static envoys and automations name policy
arrays directly in their declarations and are never rows.

## Declaring an approval flow

Attach `approval` to a write grant. Only `create`, `update` and `delete` can be gated — gating a
`read` is a compile error, because a silently dropped gate would leave an unconditional read grant
behind. An `approval` is **one function that chooses one concrete flow**, plus the teams allowed to
supersede every remaining step:

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

Details that matter:

- **The flow is ordinary TypeScript or Effect control flow**, returning `approveBy('Team', …)` —
  one or more stages, run in order — or `noApproval` explicitly. Each stage is `{ approvers }` and
  its teams are alternatives within the stage; a later stage runs after the previous one's approval.
  There is no nested `stages` array, no ids, no `description` on a stage.
- **A stage must name at least one non-empty team, and never the same team twice.**
  `superceded_by` additionally names teams that may finish every remaining step. It is distinct from
  the flow's own approvers, and it is static — which is why only its names are serialized.
- **`approvers` entries and `team` names are the same string.** There is no id resolution and no
  separate approver registry: an entry is matched against the deciding subject's own team name,
  folded, and against nothing else. Flow approver names are TypeScript-checked against the
  generated `TeamName` union at authoring time, so a misspelling fails the build; the concrete flow
  itself lives server-side and is **not** serialized.
- **The flow is snapshotted into the request.** When the request is opened, the whole
  `ApprovalConfiguration` — every stage and every `superceded_by` name — is copied into the
  request's durable state, so a later release changing the grant cannot restate an in-flight
  request.
- **Review-only teams.** Declare a team that only ever approves in `src/access/+teams.ts` with an
  empty policy list — inert for data, valid for approval.
- **What activation reconciles.** `reconcileApproverTeams` inserts an _empty_ `team` row for every
  `superceded_by` name that has no row yet, guarded by a folded `not exists` so two spellings cannot
  mint two teams. It never refuses a release, and it logs each creation — so a name here that nobody
  expected is a typo showing itself at the one moment somebody is watching. An empty team is the
  correct thing to create: the name resolves, the team appears in the settings surface, and putting
  somebody in it is one assignment away.

## Prepare, gate, commit, settle

Imperative writes (including an agent's `write_collection`) and declarative
`collections.mutate` graphs use one lifecycle:

1. **PREPARE** runs the applicable hooks and reconciles the proposed mutation graph without
   publishing its domain values.
2. The approval **gate** chooses `noApproval` or one concrete review flow.
3. `noApproval` proceeds to **COMMIT**. A gated mutation creates a request and goes on **hold**.
4. **SETTLE** follows a commit. Approval calls `collections.resume`, which commits the prepared
   create/update/delete and settles it. Rejection or withdrawal discards the prepared mutation.

While a request is held:

1. An `approval_request` row is created with status `ONGOING` (the durable state lives in
   `bolt_approvals`; the row is its synced projection).
2. A create has **no domain row**. For an update or delete, the existing committed row may carry
   `approval_id`; the proposed values or deletion have not been applied.
3. A further write to a held existing row is refused as an approval conflict naming the request,
   until the request closes.
4. The caller is answered **202** with `{ pending: true, requestId, collection, id, action }` — not
   a refusal. A tool or a screen that reports this as an error is reporting success as a failure.

The convention across workspaces is that `approval_id IS NULL` means an existing row is not held;
a non-null value identifies the open approval holding its current committed state. This convention
does not imply that a pending create exists: it does not have a domain row until approval commits it.

There is no separate "submit for approval" action. A gated write creates the request by itself. An
approval-gated collection is also never batched: `mutate` sends it down the one-row path so each
prepared mutation has its own request, which a reviewer decides separately.

## Statuses and outcomes

`approval_request.status` is one of `ONGOING`, `APPROVED`, `REJECTED`, `CHANGES_REQUESTED`,
`CONFLICTED`, `WITHDRAWN`.

| Outcome                | What happens                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Approved               | `collections.resume` commits the prepared mutation and settles it: a create inserts its row, an update applies its proposed values, and a delete removes its target. (An admin or `superceded_by` decision is the same, flagged `superseded`.)                                                                                |
| Rejected, or withdrawn | `collections.discard` drops the prepared mutation. A create has no domain row to clean up; an update or delete never applied its proposed change, so only any hold on the existing row is released.                                                                                                                            |
| Changes requested      | Same as rejected: the request closes, the prepared mutation is discarded, and the requestor can resubmit.                                                                                                                                                                                                                     |
| Conflicted             | The reviewed graph could not be settled after approval (the mutation threw, or the artifact no longer matches) — a terminal refusal that failed the turnaround.                                                                                                                                                                            |

The client's `approvals.process` accepts `APPROVED`, `REJECTED`, `REQUEST_FOR_CHANGE` and
`SUPERSEDED`; `approvals.withdraw` is the requestor's own action (only the requestor may withdraw,
and only before a decision). A surface must not invent a fifth action that the runtime cannot
decide. Each decision is annotated with `decidedBy` and an optional `reason`; a `supersede` or
`request_changes` decision requires a reason.

**Who may decide.** A subject may act on a step only if **their own team's name** — the subject's
own team, `teamPath[0]` — is in that step's `approvers`, matched case-insensitively. Eligibility does
**not** walk `teamPath`: a parent team does not inherit a child's approval rights, which is why a
real flow lists every team that may decide a step rather than only the nearest one. A step naming one
team is decidable by that exact team and nobody else, including every rung above it. On top of that,
an administrator, or a team named in the snapshot's `superceded_by`, may finish every remaining step
at once (an empty `superceded_by` means only the flow's own approvers).

## Where the state lives

| Table / column                         | Holds                                                                                                                                                                                                                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bolt_approvals` (internal)            | The durable state per request: `_tag` (`Pending`/`Approved`/`Rejected`/`ChangesRequested`/`Conflicted`/`Withdrawn`), current `step` cursor, and the **operation** under review — values, the chosen configuration (its stages and `superceded_by`), everything |
| `approval_request` (system collection) | The synced projection: `collection_name`, `record_id`, `action`, `status`, `steps` (a cursor — `[{ step: n }]` while pending, `[]` once closed), `locked_record_refs`, `proposed_values`, `closed_at`, `closed_by`                                             |
| `requestor` (system collection)        | The join table linking an `approval_request` to the user who raised it (`approval_request_id`, `user_id`)                                                                                                                                                      |
| `approval_id` on an existing row       | The stamp identifying the open request holding its current committed state; a held create has no row yet                                                                                                                                                       |
| `team`                                 | The teams themselves; `approvers` entries are matched against `name`                                                                                                                                                                                           |
| `user.team_id`                         | Which single team a person belongs to                                                                                                                                                                                                                          |

The flow itself is not a table: it is the policy grant's `approval` field — a live function choosing
the flow — and the chosen configuration is snapshotted into the request's durable state, carrying
**team names**. There is no `approval_config` with ids resolved into it, and no `_approval_lock`
table. Nothing is enforced by database triggers; the runtime checks the stamp before it writes.

`approval_request`, `requestor` and `bolt_notifications` are system collections. Whether a subject
may read them depends on its policies, but they exist and this is where the answers are. Reading
`bolt_approvals` never happens through a workspace query — its readable legs are projected into
`approval_request` visibility (raised by the subject, decided by its team, or superseded by its
team).

## Approver teams on a fresh tenant

Activation reconciles them. `reconcileApproverTeams` walks every declared `superceded_by` name and
inserts an **empty** `team` row for any name that has none, so on a brand-new tenant those teams
exist as soon as the workspace activates. It never refuses a release and never invents membership —
who is on a team is an operator's decision.

So the flow-side failure mode is a declared team that exists and is **empty**. If an approval cannot
be decided, look for a `team` row with no members — or check that the flow actually was `approveBy`
for the team that must decide, because a flow is ordinary TypeScript and a misrouted branch creates
a request nobody's team is an approver of. The activation log names every team it created.

## What does not exist

There is no UI for building or editing an approval flow, and no admin screen that adds a step or
changes who approves. Adding, removing or re-routing a flow is an edit to a policy source file
followed by a deploy — and `superceded_by`, in the same file, is the one place to define a
supersede path. When someone asks to add an approval step, that is the honest answer.
