# Models and write callbacks

Declare the entity in `src/data/model/<name>/+model.ts`. Reads, policies, views, the agent and
seeds all name that model. Its optional `+representation.svelte` receives `RecordView<'name'>`.

```ts
import { model } from '@norbital-ai/bolt';

export default model('orders', {
	description: 'Customer orders.',
	label: 'number',
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
	read: 'all',
	create: {
		columns: ['customer', 'notes'],
		transform: function* (rows, ctx) {
			const { rows: customers } = yield* ctx.db.query('customers', {
				where: { id: { in: rows.map((r) => r.customer) } },
				all: true
			});
			const blocked = new Set(customers.filter((c) => c.blocked).map((c) => c.id));
			if (rows.some((r) => blocked.has(r.customer)))
				return yield* ctx.refuse('This customer is blocked.', { field: 'customer' });
			return rows;
		}
	},
	update: {
		columns: ['status', 'notes'],
		transform: function* (changes, ctx) {
			return changes.map(({ before, set }) =>
				set.status === 'placed' && before.status === 'draft' ? { ...set, placed_at: ctx.now } : set
			);
		}
	},
	// a matching row is read-only: update and delete are refused on every path, and the record page shows a lock
	locked: { status: { eq: 'placed' } },
	queries: {
		placed_count: {
			description: 'Count placed orders visible to the caller.',
			input: {},
			output: { kind: 'int' },
			run: function* (_, ctx) {
				return (yield* ctx.query('orders', {
					where: { status: { eq: 'placed' } },
					select: { id: true },
					all: true
				})).rows.length;
			}
		}
	}
});
```

The example assumes a `customers` model with a `blocked` field. `input` types each body's input;
`output` types its return. A named query is useful for computed answers or composition; simple
filtering uses the same `query` API directly. Model writes are the standard guarded `create`,
`update`, `delete` and, on a model with a key, `upsert` verbs.

## Locks and state moves

Declare application-layer immutability once, on the model or the field:

- `locked: { status: { eq: 'paid' } }` is an own-field predicate. A matching row refuses update and
  delete on every write path (page, agent, automation, import, bulk edit, approval resubmit); the
  record page offers a lock with a reason instead of Edit. It is not a database permission and is
  not inherited by related rows unless their own model declares it.
- An `enum` field may declare `transitions: { draft: ['placed'], placed: [] }`. An update naming a
  target outside the current state's list is refused. The enum editor offers only those targets
  plus the current value.
- A `state` field remains the stricter lifecycle: `initial`, per-state `to`, and `edit` (which fields
  the state permits). Use `state` when the lifecycle owns field edits; use `enum` transitions when
  the record has independent fields and only the status moves.

Do not reimplement either rule in `update.transform`, a delete check, or a template form: the host
and the generated record UI already enforce them.

A business operation is a separately declared automation with explicit input. This started-only
run preserves the starter's authority:

```ts
// src/automation/+orders_duplicate.automation.ts
import { automation } from '@norbital-ai/bolt';
import { Effect } from 'effect';
import { Refusal } from '@norbital-ai/bolt/errors';

export default automation('orders_duplicate', {
	description: 'Copy an order as a new draft.',
	input: { order: { kind: 'id', of: 'orders' } },
	runAs: 'trigger',
	run: function* ({ order: id }, ctx) {
		const order = yield* ctx.query('orders', { id });
		if (order === null)
			return yield* Effect.fail(new Refusal({ message: 'This order is unavailable.' }));
		yield* ctx.act('orders.create', { customer: order.customer, notes: order.notes });
	}
});
```

The starter's policy needs `automations: ['orders_duplicate']` plus the order read and create
grants the run uses. A page starts it with `bolt.start('orders_duplicate', { order: id })` and
shows its run status. Several independent writes belong in one `ctx.act.many(...)` call when
they must commit atomically; dependent parent/child creates use the parent's nested `with`
input. For dependent reads and writes, `ctx.transaction(function* (tx) { ... })` uses one
native session with read-your-writes and a fixed five-second deadline; it needs no manual
observations. Its model reads and guarded CRUD retain the run's authority. Inner write answers
are provisional; the outer answer alone is committed or held. This requires PostgreSQL 17+
and is explicitly unsupported by PGlite. Keep external I/O outside the callback.
A whole automation is durable work and may contain several transactions.

## Relations

A ref carries `to`, optional `inverse`, `optional`, `owned`, `onDelete`, `where` and `default`.
`to: ['customers', 'suppliers']` is a polymorphic arc; a many-to-many link is a model with two refs.
`onDelete` is `restrict` by default, `cascade`, or `setNull` for an optional ref; owned refs cascade.
The authoring API has no `onUpdate` option. Foreign-key actions run in the database, including
cascades; callbacks should not reproduce them with delete loops.
Owned children use `with` on the parent's create/update exposure. Every nested child runs its own
write callback after the parent, batched by child model. Do not derive a child's stored values
again in the parent.

## Every write path

Native defaults, checks, uniqueness, foreign keys and state triggers own expressible database
invariants. Audited model tables also have native history triggers, including changes caused by
referential actions. Policies enforce caller authority; JavaScript callbacks retain business
validation that cannot be expressed by these native rules. A raw SQL connection is privileged
and does not acquire application policy checks merely by reaching the same table.

`create.transform(rows, ctx)` returns the rows to insert. `update.transform(changes, ctx)` receives
`{ before, set }` for each change and returns its sets. `delete.check(rows, ctx)` may refuse and
returns no replacement rows. Shared logic is an ordinary helper called by both verbs.

These callbacks run for Forms, pages, agent writes, automations, remote syncs, imports,
upserts, bulk edits, approval resubmits, per-record restore and nested owned children. They do not
run for seed restores or derived `sum`/`count` updates. They execute in the caller's transaction,
read with workspace authority through `ctx.db.query`, and have no direct writes or I/O.

## Bulk budget

One callback handles a batch, never one row at a time. The engine prefetches update `before` rows,
delete rows and upsert matches. A callback may read twice; each read may be a keyed batch of any
needed models. Prefetch before mapping, and never yield a read inside the row loop.

| Per N rows     | Cost                                       |
| -------------- | ------------------------------------------ |
| Guest calls    | ceil(N / 1000), per verb per touched model |
| Reads          | at most 2 per callback                     |
| SQL statements | O(N / 1000), set-based writes              |
| Transactions   | 1                                          |

An import is chunked at 1000 rows with a fresh 2 s CPU budget per invocation; every chunk remains
inside the import's one transaction. A refusal rolls back the whole file. History, approvals,
roll-ups and live invalidation follow those same statements.
