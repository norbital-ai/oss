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
			const { customers } = yield* ctx.db.query({
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

## Layer maps

`read`, each output, `create` and `update` are layer maps: a flat object keyed by path in the read or write
tree. `'orders'` is the root layer, `'orders.customer'` and `'orders.lines'` the layers under it,
`'orders.lines.product'` one deeper; at most five levels. Each segment is a relation of the layer
above (a ref, an inverse many-relation or an owned child), and each layer's parent is declared too
(`bolt check`: `model/layer`). `read: 'all'` is `{ <model>: { fields: 'all' } }`.

- `read` declares the `default` output; `outputs` declares named ones (never `default`), each a fixed
  layer map (`'all'` allowed). Every read names one output (`output`, `default` when absent) and its
  layer keys are that output's layers. Policies grant outputs and filter their rows; they never change
  a shape. Without `read` a model is no read root; it can still store data and be a layer of another
  model's `read`.
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

export default automation('orders_duplicate', {
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
only through a held policy's `automations: ['orders_duplicate']`; code that schedules it needs none. A page starts it with `bolt.start('orders_duplicate', { order: id })` and
shows its run status. Several independent writes belong in one `ctx.act.many(...)` call when
they must commit atomically; dependent parent/child creates nest the child rows in the parent's
write layers. For dependent reads and writes, `ctx.transaction(function* (tx) { ... })` uses one
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
there is no single-row form. `create.transform(rows, ctx)` returns the rows to insert. `update.transform(changes, ctx)` receives
`{ before, set }` for each change and returns its sets. `delete.check(rows, ctx)` may refuse and
returns no replacement rows. Shared logic is an ordinary helper called by both verbs.

These callbacks run for Forms, pages, agent writes, automations, remote syncs, imports,
upserts, bulk edits, approval resubmits, per-record restore and nested owned children. They do not
run for seed restores or derived `sum`/`count` updates. They execute in the caller's transaction,
read with workspace authority through `ctx.db.query`, and have no direct writes or I/O.

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
