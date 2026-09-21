# Collections

Collections have one server-authoritative read path and one mutation lifecycle. Browser writes,
authored code, agents, imports, approvals, history, embeddings, change events, and live-query
capture all meet at the same runtime service; none owns a parallel row model or write engine.

Source: `src/runtime/collections/`, with access decisions in `src/runtime/access/` and approval state
in `src/runtime/approvals/`.

## The write contract (`+collection.ts`)

A collection declares its write contract in `src/collections/<name>/+collection.ts`. The model stays
in `+model.ts`; the declaration names what a caller may submit and what the collection does with it.
A model with no declaration is read-only: nothing can write it, directly or through a relation.

```ts
import { Effect } from 'effect';
import { defineCollection } from '@norbital-ai/bolt/authoring';
import model from './+model.js';

export default defineCollection({
	model,
	create: {
		input: {
			columns: { employment_id: true, loan_catalogue_id: true, principal: true },
			with: { repayment_loan: { create: { columns: { due_date: true, amount_due: true } } } }
		}
	},
	update: {
		input: {
			columns: { principal: true },
			with: {
				repayment_loan: {
					create: { columns: { due_date: true, amount_due: true } },
					update: { columns: { amount_due: true } },
					delete: {}
				}
			}
		}
	},
	delete: {},
	transform: (inputs, { existing, db }) =>
		Effect.gen(function* () {
			const catalogue = yield* db.loan_catalogue.findFirst({
				where: { id: { eq: inputs[0].loan_catalogue_id } }
			});
			if (catalogue === undefined) return yield* refuse('The loan names no catalogue entry.');
			return inputs.map((input) => ({ ...input, reference: catalogue.code }));
		}),
	notifications: {
		committed: [
			{
				channel: 'inbox',
				recipients: ({ requestor }) => [requestor],
				message: () => ({ title: 'Loan saved', body: 'The loan and its repayments were saved.' })
			}
		]
	}
});
```

- **Input is what the caller may submit; payload is what the collection decides to write.** The
  selection is a positive allowlist: `columns` names fields, `with` names relation actions. Anything
  else is refused at every nesting level before the transform runs. Create requires the selected
  non-nullable, undefaulted columns; update accepts a partial. `delete: {}` exposes `delete(id)`:
  no input, no transform; dependents follow the model's `cascade()` and `onDelete`, as explicit
  operations of the same write: a cascade-owned child is deleted, a `setNull` child is updated with
  its key cleared — so history, sync capture and change events see every row the delete touched,
  never a database-side side effect they cannot.
- **Relation actions are explicit**: `create: [row]`, `update: [{ id, set }]`,
  `upsert: [{ values, onConflictDoUpdate }]`, `link: [{ id, set? }]`, `unlink: [{ id, set? }]`,
  `delete: [{ id }]`. Omitted relations and empty arrays do nothing. Nothing is ever deleted by
  omission.
- **`transform` runs once per admitted batch**, reads as the workspace through `db` (the same reads
  `api.db` offers, no writes, at most two read waves — a third read fails `ReadBudgetExceeded`), and
  returns one payload per input, in order, or refuses. Without a transform the decoded input is the
  payload. A payload reaching another collection through a relation is final: the target's
  transform does not run; the database enforces its constraints.
- **The caller is judged once, on the shape it submitted, before the transform runs**: allow
  decision, row predicate, field grant, per nested action at its input path; `authorize` and the
  approval route of the root grant on the rows as the engine will write them. Everything the
  transform adds is the workspace's own work.
- **One operation is one statement**: the graph, its history, the outbox, the approval hold and
  its request row, notification rows, the ledger claim and the read-back of what was written are
  pieces of one `WITH` chain (`src/runtime/collections/write/one-statement.ts`). Rows of one shape
  are one piece carried as one `jsonb` recordset parameter; a version guard rides inside each update
  and delete; every guard is a `select bolt_assert(…)` piece the statement's anchor references, so a
  refusal fails the whole statement. The one thing outside it is the `lock table` a transform's
  reads need, sent first. Every sub-statement sees the snapshot the statement began with, so a piece
  that must observe another reads its `returning` set by name, never the table. Every multi-operation commit records a `write`
  telemetry slice — collection, rows, statements, pieces, ms, shapes — kept in the tenant
  `telemetry` collection; a single-operation commit records nothing.
- **Versions are not part of the API.** The browser attaches the observed `row_version` of every row
  its input names as request metadata; the engine asserts them and fails the whole operation as a
  version conflict if one moved.
- **Notifications** declare, per lifecycle event (`committed`, `rejected`, `approvalStarted`,
  `approvalStepRequested`, `approvalStepApproved`, `approvalChangesRequested`, `approvalWithdrawn`,
  `approvalSuperseded`, `approvalConflicted`, `approvalCompleted`), a channel from the deployment's
  catalogue (`inbox`), recipients — user ids, or `{ team: 'HR Manager' }` for every member of a
  team at commit time (an approval step's `approvers` are team names) — and a message; the ledger
  rows are pieces of the write's own statement and `notifications.deliver` delivers them.

Callers reach a collection through `api.collection.<name>.create(input)` / `.createMany(inputs)` /
`.update(id, input)` / `.updateMany(inputs)` / `.delete(id)` / `.deleteMany(ids)` on the server,
and `client.collection.<name>` with the same names in the browser (queued in the tab's memory,
painted over live reads until the authority settles). Agent tools, integration pulls, imports,
seeds and the runtime's own bookkeeping are callers like any other. A relation given to the browser
as a plain array of rows (a form matrix) is diffed against the children the tab has loaded and sent
as explicit actions; the wire never carries an omission.

History reads live beside the writes: `api.collection_history.<name>.revisions(id)` is every
revision oldest first, `.at(id, anchor)` is the record at `{ instant }`, `{ revision }` or
`{ before: approvalId }` (the restore point of an approval). `client.collection_history` is the
browser mirror, one-shot, never live.

## Reads

The shared query input supports `where`, `orderBy`, `limit`, `with`, root `columns`, explicit
`search`, and seek cursor `after`. PostgreSQL evaluates predicates and ordering under the effective
subject's read policy. Relation loading uses the same compiled relationship truth, and field masks
apply to the projected answer rather than changing predicate meaning.

- Cursors encode the prior row's ordering tuple; there is no offset pagination.
- Live ordering is typed: a live read's `orderBy` accepts only the collection's scalar columns
  (`CollectionLiveOrderBy`); json, custom-typed and vector columns fail at authoring time and are
  refused by the planner. A read continued with `after` is one-shot and may order by any column.
- Lexical search is opt-in per field with `search: true`.
- Semantic search performs one embedding request, then one policy-filtered nearest-neighbour query.
- Every collection also offers `/text` and `/semantic`; a declared `similarity` index adds
  `/<index>`, whose target is a capture-form value the workspace embeds. Raw vectors are never
  accepted from the browser.
- `findNearest` is a server operation.
- Grouped reads are exact, server-side, and bounded; they are not recomputed from a browser page.
- History reconstruction happens before policy masking, so a field mask cannot change patch meaning.

Live prefixes versus one-shot reads, and the keyed-delta / reset wake, are documented in
[P4 Sync engine](../pillars/04-sync-engine/README.md).

## Write lifecycle

```text
declared inputs (one collection, one action, a batch)
  │
  ├─ PREPARE  refuse anything the selection does not name; judge the caller per submitted row;
  │           one wave for the rows the batch names; assert observed versions; hold check;
  │           run the transform (reads recorded); lower the payload graph; read delete cascades
  ├─ GATE     `authorize` and the approval route on the root rows; the batch shares one route
  ├─ COMMIT   one statement: guards, deletes, updates, creates, history, the hold and its
  │           request row, notification rows, the ledger claim, the capture
  └─ SETTLE   sync publish, change-triggered automations, embeddings
```

Nested graph writes and cascading deletes are bounded to eight levels; an ordinary write changes
at most 10,000 rows.

## Approval and idempotency

Approval is a state machine over one write's graph, not a second write path. When policy routes a
write to approval the graph is committed **provisionally** in the same transaction as the request:
every row it creates or updates is stamped `approval_id`, a `hold` revision records each row's
pre-image (or its absence), and the caller gets `pendingApproval: { requestId }` (202 in the
browser). Provisional rows are real rows — sync pushes them, reports see them — and `approval_id`
is how a consumer tells them apart. A write that reaches a held row fails `ApprovalHeld` unless
its subject is a participant of the request; a participant's write is stamped and hold-revisioned
too. Sealing (the last step approved) clears the stamps and fires `committed`; refusing restores
every touched row to its `hold` snapshot. See [approvals](../access/approvals.md).

Browser writes are keyed by tenant, environment, principal, effective authority, command, and
idempotency key. The durable outcome distinguishes committed, pending approval, version conflict,
rejected, and quarantined work. Reusing a key with different canonical input is refused. A matching
schema transition may rebase; an uninterpretable release mismatch stays quarantined rather than
being reported saved.

## Side effects and durable evidence

- History records create, update, delete, hold and restore revisions; its default projected horizon
  is 256, and a prune never crosses the restore point of an open approval.
- Audit joins data writes, browser outcomes, and approval decisions without inventing a second
  mutation history.
- Change events are emitted from committed graph coordinates.
- Record embeddings are refreshed after writes and claimed in bounded batches of at most 512.
- Sync change capture is part of COMMIT. Host handoff happens during SETTLE and cannot change whether
  the database transaction committed.

The database remains the only durable row truth. Browser optimistic state and live-query registries
are projections with explicit settlement and reconnect behavior, never replicas.
