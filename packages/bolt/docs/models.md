# Models and write callbacks

Declare the entity in `src/data/model/<name>/+model.ts`. Reads, policies, views, the agent and
seeds all name that model. Its optional `+representation.svelte` receives `RecordView<'name'>`.
Model folders may nest under other models or ordinary grouping folders. For example,
`src/data/model/payroll/payroll_run/payslip/+model.ts` declares `model('payslip', …)`;
the leaf name remains unique across the workspace. Grouping folders need no declaration, and a
representation stays beside its own `+model.ts`.

```ts
import { model } from '@norbital-ai/bolt';

export default model('orders', {
	description: 'Customer orders.',
	record_label: 'record.number',
	fields: {
		number: { kind: 'seq', pattern: 'SO-{yyyy}-{0000}' },
		customer: { kind: 'ref', to: 'customers', inverse: 'orders' },
		status: {
			kind: 'enum',
			values: ['draft', 'placed', 'cancelled'],
			default: 'draft',
			transitions: { draft: ['placed', 'cancelled'], placed: ['cancelled'], cancelled: [] }
		},
		notes: { kind: 'text', optional: true },
		placed_at: { kind: 'instant', optional: true }
	},
	read: {
		orders: { fields: ['number', 'customer', 'status', 'notes', 'placed_at'] },
		'orders.customer': { fields: ['name', 'code'] },
		'orders.lines': { fields: ['product', 'quantity', 'net'] },
		'orders.lines.product': { fields: ['code', 'name'] }
	},
	// a named output beside `default`: what the warehouse reads
	outputs: {
		logistics: {
			orders: { fields: ['number', 'status'] },
			'orders.lines': { fields: ['product', 'quantity'] }
		}
	},
	create: {
		columns: { orders: ['customer', 'notes'], 'orders.lines': ['product', 'quantity', 'net'] },
		transform: function* (rows, ctx) {
			const { customers } = yield* ctx.query({
				customers: { where: { id: { in: rows.map((r) => r.customer) } }, fields: ['blocked'] }
			});
			const blocked = new Set(customers.rows.filter((c) => c.blocked).map((c) => c.id));
			const at = rows.findIndex((r) => blocked.has(r.customer));
			if (at >= 0)
				return yield* ctx.refuse('This customer is blocked.', { field: 'customer', row: at });
			return rows;
		}
	},
	update: {
		columns: { orders: ['status', 'notes'], 'orders.lines': ['product', 'quantity', 'net'] },
		transform: function* (changes, ctx) {
			return changes.map(({ before, set }) =>
				set.status === 'placed' && before.status === 'draft' ? { ...set, placed_at: ctx.now } : set
			);
		}
	},
	// a matching row is read-only: update and delete are refused on every path, and the record page shows a lock
	locked: { status: { eq: 'placed' } }
});
```

The example assumes `customers` (with `code`, `blocked`), `order_lines` (`order` owned, inverse
`lines`) and `products`. Model writes are the standard guarded `create`, `update`, `delete` and, on
a model with a key, `upsert` verbs. A model declares no named queries: callers read the layers
they need and transform them with a pure `src/lib` helper on their own side.

## One record identifier

Optionally declare `record_label` as a pure CEL expression over `record`:

```ts
record_label: "record.code + ' · ' + record.name",
indexes: { find: { text: ['email'] } } // additional terms beside the identifier
```

This is the default identifier for `RecordShell` titles, the primary text column and compact
list headings produced by `Table`, default board card headings, pickers, relationship references,
and record results in Find and Norbius. Explicit authored titles or cell/card snippets override
the default. Declare the identifier once instead of reconstructing it in each representation.
Field captions continue to use ordinary `label` text.

Omitting it is valid: no identifier column or automatic label index is created. Record views, lists, pickers and references use the record id (UUID) as their identifier;
approvals use the target record UUID from the existing reference. Explicit text indexes still work
without a label. With neither a label nor a text index, record search is unavailable and Find
explains that no search index is declared. Model discovery itself remains available.

Use own stored fields, sequences, computed fields, or nested values inside an inline field.
For optional values use a conditional, such as `record.name != null ? record.name : 'Unnamed'`;
use `string(record.quantity)` to include a number. A label may also read a to-one relation's fields one hop deep when the default output exposes them.
Clocks and requestor variables are excluded. Relation-dependent labels resolve with their related
rows through the normal read path. `bolt check` reports invalid
CEL, unsupported operators and unknown fields at the declaring model.

The compiler creates an engine-owned generated text column, `bolt_record_label`, and includes
its value in the GIN-backed `bolt_search` document. No duplicate field or explicit label search
index is needed. Sequence and computed values are available before it is calculated; inserts,
updates, imports and restores recalculate it. Changing the expression generates a migration that
rebuilds stored identifiers and their search document for existing rows. Text indexes add other
fields, while semantic and custom indexes keep their existing roles.

Approval requests reuse their existing `collection_name` and `record_id` reference. Search joins
the target's indexed label and resolves its current identifier at read time; no target label is
stored on `approval_request`. A label edit is reflected immediately, including on closed requests.
Only the target label is matched through this reference, not its other text-search fields or ID.
The target's row grants and readable label dependencies apply, including named-only outputs.
A missing, inaccessible or unlabelled target uses its existing record UUID as the fallback. The approval
model has its own text index for that model name.

Read outputs must expose the fields used by the expression. A restricted output uses the record
id when it hides a label dependency. `record_label` is model metadata.

## Output trees and write layers

- `outputs` declares `default` and any named outputs. Each output lists `fields` (or `'all'`) and
  nests a projection under each relation it exposes. For example, use
  `{ fields: ['number'], customer: { fields: ['name'] } }`. A read uses `default` unless it
  names another `output`. Policies grant outputs and filter their rows. A model without an output
  can still store data and appear in another model's output tree.
- `create.columns` / `update.columns` declare the writable columns per layer. A write layer is a
  many-relation (the child rows); it never lists the key that ties a child to its parent.
  `create.filled` names columns the transform fills when the writer omits them.
- A write payload stays a tree. A create row is `{ customer, notes, lines: [{ product, quantity, net }] }`
  (a non-owned child may also be an existing row's id, which links it). An update `set` names the
  root columns and, per child layer, `{ create?, update?: [{ target, set }], delete?, link?, unlink? }`.
- `.norbital/names.ts` generates the path unions (`ReadPath<'orders'>`, `WritePath<'orders', 'create'>`)
  and the model behind each path, so every layer value types against the right model.

## Locks and state moves

Declare application-layer immutability once, on the model or the field:

- `constraints: { paid: { locked: { status: { eq: 'paid' } } } }` makes a matching row read-only.
  Add `except: ['note']` to allow edits to selected fields. Each matching lock must allow a field
  for it to be editable. A matching row cannot be deleted. Related rows use their own model's rules.
- An `enum` field may declare `transitions: { draft: ['placed'], placed: [] }`. An update naming a
  target outside the current state's list is refused. The enum editor offers only those targets
  plus the current value.
- A `state` field remains the stricter lifecycle: `initial`, per-state `to`, and `edit` (which fields
  the state permits). Use `state` when the lifecycle owns field edits; use `enum` transitions when
  the record has independent fields and only the status moves. Policies authorize edges through
  `update.moves`.

Do not reimplement either rule in `update.transform`, a delete check, or a template form: the host
and the generated record UI already enforce them.

Work that follows a committed write is the model's `effect`, one generator per verb:

```ts
effect: {
	created: function* (rows, ctx) {},              // the committed rows
	updated: function* (changes, ctx) {},           // [{ before, after }], a stored field changed
	deleted: function* (rows, ctx) {}               // the stored rows
}
```

Each runs after the commit, once per committed batch, as the durable run `<model>.effect.<verb>`
(retried, shown in the Command center's runs). It runs as the writer and holds no policy; its rows
are the root fields of the writer's output of the model (`default` when it holds it, else the first
named output it holds). See [APIs](./apis.md) for depth and authority.

A business operation is a separately declared automation with explicit input. The system identity
runs it with its declared `policies`; `ctx.run.trigger` records who started it:

```ts
// src/automation/+orders_duplicate.automation.ts
import { automation } from '@norbital-ai/bolt';
import { Effect } from 'effect';
import { Refusal } from '@norbital-ai/bolt/errors';

export default automation({
	description: 'Copy an order as a new draft.',
	input: { order: { kind: 'id', of: 'orders' } },
	policies: ['order_duplicating'],
	run: function* ({ order: id }, ctx) {
		const { orders } = yield* ctx.query({ orders: { where: { id: { eq: id } }, limit: 1 } });
		const order = orders.rows[0];
		const by = ctx.run.trigger;
		// only the starter's own orders: the run's authority is its policies, so the body checks the starter
		if (
			order === undefined ||
			by.kind !== 'person' ||
			by.actor.kind !== 'member' ||
			order.owner !== by.actor.id
		)
			return yield* Effect.fail(new Refusal({ message: 'This order is unavailable.' }));
		yield* ctx.act('orders.create', [
			{ customer: order.customer, notes: order.notes, owner: order.owner }
		]);
	}
});
```

`order_duplicating` grants the order read and create the run uses. Its `requestor.*` operands name
the system identity, so a rule about the starter is code over `ctx.run.trigger`, and a ref the run
writes is set explicitly (a `requestor.id` default does not apply). A person or the agent starts it by hand
only through a held policy's `capabilities.automations`; code that schedules it needs none. A page starts it with `ctx.run('orders_duplicate', { order: id })` and
shows its run status. Several independent writes belong in one `ctx.act.many(...)` call when
they must commit atomically; dependent parent/child creates nest the child rows in the parent's
write layers. A transform can carry other rows into the same commit. A whole automation is durable work and may contain several independent commits.

## Relations

A ref carries `to`, optional `inverse`, `optional`, `owned`, `onDelete`, `where` and `default`.
`to: ['customers', 'suppliers']` is a polymorphic arc; a many-to-many link is a model with two refs.
`onDelete` is `restrict` by default, `cascade`, or `setNull` for an optional ref; owned refs cascade.
The authoring API has no `onUpdate` option. Foreign-key actions run in the database, including
cascades; callbacks should not reproduce them with delete loops.
Owned children are write layers of the parent's create/update. Every nested child runs its own
write callback after the parent, batched by child model. Do not derive a child's stored values
again in the parent.
Authority is per access point: `read`, `create`, `update` and `delete` of a model are access points,
guarded by that model's policy only, every layer under them included. A child written through its
parent's layers, or a related row read as a layer, is judged by the root model's grant alone; the
child model's own policy is never consulted on that path. Its `transform`/`check` still run as
business validation. Reading or writing the child model directly is its own access point.

## Every write path

Native defaults, checks, uniqueness, foreign keys and state triggers own expressible database
invariants. Audited model tables also have native history triggers, including changes caused by
referential actions. Policies enforce caller authority; JavaScript callbacks retain business
validation that cannot be expressed by these native rules. A raw SQL connection is privileged
and does not acquire application policy checks merely by reaching the same table.

Every generated write's input is an array of rows (`[{ … }]`, `[{ target, set }]`, `[{ target }]`);
there is no single-row form. `create.transform(rows, ctx)` returns the rows to insert; each row it receives carries the `id` it will have. `update.transform(changes, ctx)` receives
`{ before, set }` for each change and returns its sets. `delete.check(rows, ctx)` may refuse and
returns no replacement rows. Shared logic is an ordinary helper called by both verbs.

A transform may instead return `{ rows, with, onApproved }`, and a delete check `{ with, onApproved }`,
each `{ [model]: { create?: [row], update?: [{ target, set, observed? }] } }`: rows of other models the
write carries into its own transaction. They run their own model's callbacks (`ctx.carried_by` names the
carrying model), the root write's grant admits them, and an `observed` revision older than the stored
one is a conflict.

- `with` is part of the write: held with it under an approval, locked like owned children, rolled back
  on rejection.
- `onApproved` follows the write once it is approved: at once when no approval holds it. When one does,
  the approving decision asks the request model's callback again (`ctx.approving`) for every held row
  at once, one call per verb, on the records as they now stand (an update's `{ before: row, set: {} }`),
  plans what they carry together and commits it in the decision's one statement. A refusal or conflict
  there leaves the request pending; a rejection writes none. A change to a held record waits the same
  way. Ledger and balance postings belong here.

These callbacks run for Forms, pages, agent writes, automations, remote syncs, imports,
upserts, bulk edits, approval resubmits, per-record restore and nested owned children. They do not
run for seed restores or derived `sum`/`count` updates. They execute in the caller's transaction,
read with workspace authority through `ctx.query`, and have no direct writes or I/O.

## Bulk budget

One callback handles a batch, never one row at a time. The engine prefetches update `before` rows,
delete rows and upsert matches. A callback may read up to ten times, one dependent wave per read;
each read is one read request naming every root it needs. Prefetch before mapping, and never yield a read inside the row loop. Each
policy `check` that admits the batch is one more guest call per verb per model, with the same
read budget.

| Per N rows     | Cost                                       |
| -------------- | ------------------------------------------ |
| Guest calls    | ceil(N / 1000), per verb per touched model |
| Reads          | at most 10 per callback                    |
| SQL statements | O(N / 1000), set-based writes              |
| Transactions   | 1                                          |

An import is chunked at 1000 rows with a fresh 3 s CPU budget per invocation; every chunk remains
inside the import's one transaction. A refusal rolls back the whole file. History, approvals,
roll-ups and live invalidation follow those same statements.
