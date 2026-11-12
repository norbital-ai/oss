# Models and write callbacks

Declare the entity in `src/data/model/<name>/+model.ts`. Reads, policies, views, the agent and
seeds all name that model. Its optional `+representation.svelte` receives `RecordView<'name'>`.
Model folders may nest under other models or ordinary grouping folders. For example,
`src/data/model/payroll/payroll_run/payslip/+model.ts` declares `model(spec)`;
the leaf name remains unique across the workspace. Grouping folders need no declaration, and a
representation stays beside its own `+model.ts`.

`bolt check` generates one typed binding per model under `.norbital/models/`. Import the
binding for this file and call `model(spec)`. The binding supplies the row and callback types,
and the compiler verifies that it matches the file's leaf name. The relative path below is
for `src/data/model/orders/+model.ts`. Nested model folders need the corresponding extra
parent segments.

```ts
import { model } from '../../../../.norbital/models/orders.ts';

export default model({
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
	// a named output beside `default`: what the warehouse reads
	outputs: {
		default: {
			fields: ['number', 'customer', 'status', 'notes', 'placed_at'],
			customer: { fields: ['name', 'code'] },
			lines: { fields: ['product', 'quantity', 'net'], product: { fields: ['code', 'name'] } }
		},
		logistics: {
			fields: ['number', 'status'],
			lines: { fields: ['product', 'quantity'] }
		}
	},
	create: {
		columns: { fields: ['customer', 'notes'], lines: { fields: ['product', 'quantity', 'net'] } },
		transform: function* (changes, ctx) {
			const { customers } = yield* ctx.query({
				customers: { where: { id: { in: changes.map((c) => c.after.customer) } }, fields: ['blocked'] }
			});
			const blocked = new Set(customers.rows.filter((c) => c.blocked).map((c) => c.id));
			const at = changes.findIndex((c) => blocked.has(c.after.customer));
			if (at >= 0)
				return yield* ctx.refuse('errors.customer_blocked', { field: 'customer', row: at });
			return changes.map((c) => c.set);
		}
	},
	update: {
		columns: { fields: ['status', 'notes'], lines: { fields: ['product', 'quantity', 'net'] } },
		transform: function* (changes, ctx) {
			// `after` is the row as this write leaves it: the stored values with `set` applied
			return changes.map((c) =>
				c.changed('status') && c.after.status === 'placed' ? { ...c.set, placed_at: ctx.now } : c.set
			);
		}
	},
	// a matching row is read-only: update and delete are refused on every path, and the record page shows a lock
	constraints: { placed: { locked: { status: { eq: 'placed' } } } }
});
```

The example assumes `customers` (with `code`, `blocked`), `order_lines` (`order` owned, inverse
`lines`) and `products`. Model writes are the standard guarded `create`, `update`, `delete` and, on
a model with an `import_key`, `import` verbs. A model declares no named queries: callers read the layers
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
Field captions and help come from the message catalog by convention, with humanized captions
when no override exists. Declaration fields do not accept inline `label` or `help`.

Omitting it is valid: no identifier column or automatic label index is created. Record views, lists, pickers and references use the record id (UUID) as their identifier;
approvals use the target record UUID from the existing reference. Explicit text indexes still work
without a label. With neither a label nor a text index, record search is unavailable and Find
explains that no search index is declared. Model discovery itself remains available.

Use own stored fields, sequences, computed fields, or nested values inside an inline field.
For optional values use a conditional, such as `record.name != null ? record.name : 'Unnamed'`;
use `string(record.quantity)` to include a number. A label may also read a to-one relation's
fields one hop deep when the selected output exposes them, including a named output whose
default hides them.
Clocks and requestor variables are excluded. Relation-dependent labels resolve with their related
rows through the normal read path. `bolt check` reports invalid
CEL, unsupported operators and unknown fields at the declaring model.

For an own-field label, the compiler creates an engine-owned generated text column, `bolt_record_label`, and includes
its value in the GIN-backed `bolt_search` document. No duplicate field or explicit label search
index is needed. Sequence and computed values are available before it is calculated; inserts,
updates, imports and restores recalculate it. Changing the expression generates a migration that
rebuilds stored identifiers and their search document for existing rows. Text indexes add other
fields, while semantic and custom indexes keep their existing roles.

A relation-dependent label is evaluated while reading its declared output layers. It has no
stored label column or copied target text. Its lexical search uses that current authorized label,
and a related-row change refreshes affected live reads. Hiding a dependency or its related row
uses the record id without matching the hidden text.

Approval requests reuse their existing `collection_name` and `record_id` reference. Search joins
the target's indexed label and resolves its current identifier at read time; no target label is
stored on `approval_request`. A label edit is reflected immediately, including on closed requests.
Only the target label is matched through this reference, not its other text-search fields or ID.
The target's row grants and readable label dependencies apply, including named-only outputs.
A missing, inaccessible or unlabelled target uses its existing record UUID as the fallback. The approval
model has its own text index for that model name.

The selected output's fields, layers and row grants determine whether its label is visible.
An output that hides a dependency uses the record id, while another output may expose the label.
`record_label` is model metadata.

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
  (a non-owned child may also be an existing row, `{ id, revision }`, which links it). An update `set` names the
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
- A `state` field declares `initial`, per-state `to` and optional transition `stamp` fields.
  Named lock constraints own editable exceptions through `except`. Policies authorize edges through
  `update.moves`.

Do not reimplement either rule in `update.transform` or a template form: the host
and the generated record UI already enforce them.

Work that follows a committed write is the model's `effect`, one generator per verb:

```ts
create: { /* columns, transform, ... */ effect: function* (changes, ctx) {} },
update: { /* columns, transform, ... */ effect: function* (changes, ctx) {} },
delete: { effect: function* (changes, ctx) {} }
```

Each runs after the commit, once per committed batch, as the durable run `<model>.effect.<verb>`
(retried, shown in the Command center's runs). It runs as the writer and holds no policy; its rows
are the root fields of the writer's output of the model (`default` when it holds it, else the first
named output it holds). Each change carries `before`, `set`, `after` and `changed(...fields)`.
Approval lifecycle events carry an empty change list and `ctx.event.kind === 'approval'`.
Held write effects are frozen until final approval, then released atomically; rejection discards
them. See [APIs](./apis.md) for depth and authority.

A business operation is a separately declared automation with explicit input. The system identity
runs it with its declared `policies`; `ctx.run.trigger` records who started it:

```ts
// src/automation/+orders_duplicate.automation.ts
import { automation } from '@norbital-ai/bolt';

export default automation({
	description: 'Copy an order as a new draft.',
	// the caller sends ids; the body receives the rows, read under the run's policies (an unreadable id refuses the start)
	input: { orders: { kind: 'rows', of: 'orders' } },
	policies: ['order_duplicating'],
	run: function* ({ orders }, ctx) {
		const by = ctx.run.trigger;
		// only the starter's own orders: the run's authority is its policies, so the body checks the starter
		const row = orders.findIndex((order) =>
			by.kind !== 'person' || by.actor.kind !== 'member' || order.owner !== by.actor.id);
		if (row >= 0) return yield* ctx.refuse('errors.order_unavailable', { row });
		yield* ctx.act({ 'orders.create': orders.map((order) =>
			({ customer: order.customer, notes: order.notes, owner: order.owner })) });
	}
});
```

`order_duplicating` grants the order read and create the run uses. Its `requestor.*` operands name
the system identity, so a rule about the starter is code over `ctx.run.trigger`, and a ref the run
writes is set explicitly (a `requestor.id` default does not apply). A person or the agent starts it by hand
only through a held policy's `capabilities.automations`; code that schedules it needs none. A page starts it with `ctx.run('orders_duplicate', { orders: [id] })` and
shows its run status. Several independent writes belong in one `ctx.act({ ... })` map when
they must commit atomically; dependent parent/child creates nest the child rows in the parent's
write layers. A transform can carry other rows into the same commit. A whole automation is durable work and may contain several independent commits.

## Relations

A ref carries `to`, optional `inverse`, `optional`, `owned`, `on_delete`, `where` and `default`.
`to: ['customers', 'suppliers']` is a polymorphic arc; a many-to-many link is a model with two refs.
`on_delete` is `restrict` by default, `cascade`, or `set_null` for an optional ref; owned refs cascade.
Foreign-key update actions are not authored. Delete actions run in the database, including
cascades; callbacks should not reproduce them with delete loops.
Owned children are write layers of the parent's create/update. Every nested child runs its own
write callback after the parent, batched by child model. Do not derive a child's stored values
again in the parent.
Authority is per access point: `read`, `create`, `update` and `delete` of a model are access points,
guarded by that model's policy only, every layer under them included. A child written through its
parent's layers, or a related row read as a layer, is judged by the root model's grant alone; the
child model's own policy is never consulted on that path. Its transforms and constraints still run as
business validation. Reading or writing the child model directly is its own access point.

## Every write path

Native defaults, checks, uniqueness, foreign keys and state triggers own expressible database
invariants. An act's one statement writes the history of its rows and of the cascades and unlinks
its deletes imply; audited model tables keep a native history trigger for raw SQL. Policies enforce caller authority; JavaScript callbacks retain business
validation that cannot be expressed by these native rules. A raw SQL connection is privileged
and does not acquire application policy checks merely by reaching the same table.

Every generated write's input is an array of rows (`[{ … }]`, `[{ target, set }]`, `[{ target }]`);
there is no single-row form. Create and update transforms receive `{ before, set, after, changed }`
changes and return sets in order. `after` is the row as the write leaves it: the stored values with
`set` applied, so read a value from `c.after.x`, never `c.set.x ?? c.before.x`, and test a change with
`c.changed('x')`. A create's `after` carries its future id. Delete has no transform;
policies and native constraints judge deletion. Shared logic is an ordinary helper called by both verbs.

`target` is a row: pass the row you read or received (it carries its `id` and `revision`, and a newer
stored revision is a conflict). An automation that acts on records takes them as
`{ kind: 'rows', of: '<model>' }`: a caller sends ids, and the body receives the rows read under the
run's policies, so `ctx.act({ 'orders.update': orders.map((order) => ({ target: order, set })) })`
needs no read of its own.

A body says no with `return yield* ctx.refuse('<message key>', { row?, field? })`. The message is a
key of the workspace catalogue (`src/i18n/+messages.ts`); `row` is the offending row's index in the
batch or list the body received, and `field` one of its root columns. The failure is a `Refusal`;
bodies never construct one.

A transform may instead return `{ sets, with, on_approved }`,
each carried map `{ [model]: { create?: [row], update?: [{ target, set }] } }`: rows of other models the
write carries into its own transaction. They run their own model's callbacks (`ctx.carried_by` names the
carrying model), the root write's grant admits them, and a target's selected revision older than the
stored one is a conflict.

- `with` is part of the write: held with it under an approval, locked like owned children, rolled back
  on rejection.
- `on_approved` follows the write once it is approved: at once when no approval holds it. When one does,
  the approving decision asks the request model's callback again (`ctx.approving`) for every held row
  at once, one call per verb, on the records as they now stand (an update has current `before` and
  `after` trees, an empty `set` and `changed(...)`),
  plans what they carry together and commits it in the decision's one statement. A refusal or conflict
  there leaves the request pending; a rejection writes none. A change to a held record waits the same
  way. Ledger and balance postings belong here.

These callbacks run for Forms, pages, agent writes, automations, remote syncs, imports,
bulk edits, approval resubmits, per-record restore and nested owned children. They do not
run for seed restores or derived `sum`/`count` updates. They execute in the caller's transaction,
read with workspace authority through `ctx.query`, and have no direct writes or I/O.

## Bulk budget

One callback handles a batch, never one row at a time. The engine prefetches update `before` rows,
delete rows and import-key matches. A callback may read up to ten times, one dependent wave per read;
each read is one read request naming every root it needs. Prefetch before mapping, and never yield a read inside the row loop. Each
policy `verdict` that admits the batch is one more guest call per verb per model, with the same
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
