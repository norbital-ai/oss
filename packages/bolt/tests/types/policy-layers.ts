// Type corpus for layer-map policies (decision 3, plan "Type safety of the policy"): everything a grant says is typed from
// the model's own declaration. Each `@ts-expect-error` line is a planted mistake from the plan's table; a clean tsc proves
// every valid literal compiles and every mistake is refused at its literal.
import { policy } from '../../src/index.ts';
import type { ColumnValue, LayerValue, Masked } from '../../src/decl/names.ts';
import type {
	CreateTree,
	LayerField,
	PathModel,
	ReadPath,
	StoredTree,
	UpdateTree,
	WritePath
} from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;
type System = 'id' | 'revision' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by';

// ── the generated path unions and the model behind each path ──
is<Eq<ReadPath<'orders'>, 'orders' | 'orders.customer' | 'orders.lines'>>();
is<Eq<WritePath<'orders', 'create'>, 'orders' | 'orders.lines'>>();
is<Eq<PathModel<'orders', 'orders.lines'>, 'order_lines'>>();
is<Eq<PathModel<'orders', 'orders'>, 'orders'>>();
is<Eq<Exclude<LayerField<'orders', 'orders.customer'>, System>, 'name' | 'tier'>>();
// ── the trees a check judges ──
is<Eq<keyof CreateTree<'orders'>, 'customer' | 'note' | 'due' | 'lines'>>();
is<Eq<keyof NonNullable<CreateTree<'orders'>['lines']>[number], 'item' | 'qty' | 'price'>>();
is<Eq<keyof UpdateTree<'orders'>, 'status' | 'note' | 'due' | 'placed_at' | 'lines'>>();
is<Eq<'lines' extends keyof StoredTree<'orders', 'update'> ? 1 : 0, 1>>();

// ── valid ──
export const layered = policy({
	description: 'Sell to our customers, through the order tree',
	grants: {
		orders: {
			read: {
				orders: { where: { owner: { eq: { var: 'requestor.id' } } }, fields: ['number', 'status', 'customer'] },
				'orders.customer': { fields: ['name'] },
				'orders.lines': { where: { item: { ne: '' } } }
			},
			history: true,
			create: {
				columns: { orders: ['customer', 'note'], 'orders.lines': ['item', 'qty'] },
				check: function* (rows, ctx) {
					const bad = rows.findIndex((o) => (o.lines ?? []).some((l) => l.item === ''));
					if (bad >= 0)
						return ctx.deny('Every line names its item.', { row: bad, path: 'orders.lines', field: 'item' });
					const { customers } = yield* ctx.db.query({
						customers: { where: { id: { in: rows.map((r) => r.customer) } }, fields: ['tier'] }
					});
					return customers.rows.every((c) => c.tier === 'gold')
						? ctx.allow()
						: ctx.approve((flow) => flow.step('Sales review', { teams: ['sales'] }));
				}
			},
			update: {
				columns: { orders: ['status', 'note'] },
				check: function* (changes, ctx) {
					const me = ctx.actor.kind === 'member' ? ctx.actor.id : null;
					const mine = changes.every((c) => c.before.owner === me && c.before.lines.length < 100);
					return mine ? ctx.allow() : ctx.deny('Only your own orders change.', { field: 'status' });
				}
			},
			delete: {
				check: function* (rows, ctx) {
					return rows.length < 10 ? ctx.allow() : ctx.deny('Delete fewer at once.', { row: 0 });
				}
			}
		},
		notices: { read: true },
		customers: { update: true }
	}
});

// ── refused: each line one row of the plan's table ──
policy({
	description: 'x',
	// @ts-expect-error a read layer the model does not declare (`owner` is a relation, never a layer)
	grants: { orders: { read: { 'orders.owner': {} } } }
});
policy({
	description: 'x',
	// @ts-expect-error a field from another layer (`note` is the root's)
	grants: { orders: { read: { 'orders.customer': { fields: ['note'] } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a column the model's create does not declare
	grants: { orders: { create: { columns: { orders: ['status'] } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a write path the model's create does not declare
	grants: { orders: { create: { columns: { 'orders.customer': ['name'] } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a verb the model does not declare (sites declares no create)
	grants: { sites: { create: true } }
});
policy({
	description: 'x',
	// @ts-expect-error `read` on a model without `read`
	grants: { sys_session: { read: true } }
});
policy({
	description: 'x',
	// @ts-expect-error a write grant's `where` is gone: judge the batch in `check`
	grants: { orders: { update: { where: { status: { eq: 'draft' } } } } }
});
policy({
	description: 'x',
	// @ts-expect-error an unknown ctx member
	grants: { orders: { delete: { check: function* (_rows, ctx) { return ctx.refuse('no'); } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a plain-object verdict
	grants: { orders: { delete: { check: function* () { return { kind: 'allow' }; } } } }
});
policy({
	description: 'x',
	// @ts-expect-error `deny`'s path is a write path of this verb
	grants: { orders: { create: { check: function* (_rows, ctx) { return ctx.deny('no', { path: 'orders.customer' }); } } } }
});
policy({
	description: 'x',
	// @ts-expect-error `deny`'s field is a column of its path
	grants: { orders: { create: { check: function* (_rows, ctx) { return ctx.deny('no', { path: 'orders.lines', field: 'note' }); } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a mistyped `check` argument
	grants: { orders: { create: { check: function* (_rows: readonly { readonly nope: 1 }[], ctx) { return ctx.allow(); } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a relation the create does not declare is not in its rows
	grants: { orders: { create: { check: function* (rows, ctx) { return rows[0]?.notes === undefined ? ctx.allow() : ctx.allow(); } } } }
});
policy({
	description: 'x',
	// @ts-expect-error policy `queries` and `via` are gone
	grants: { orders: { queries: ['open_total'] }, order_lines: { via: 'order' } }
});

// ── masking per path: a grant that does not name a declared layer reads it in full, so auditor's narrow
// `orders.lines` masks nothing while sales_rep reads that layer whole; both narrow `orders.customer` to `name` ──
is<Eq<LayerValue<'orders', 'orders.lines', 'qty'>, ColumnValue<'order_lines', 'qty'>>>();
is<Eq<Masked extends LayerValue<'orders', 'orders.customer', 'tier'> ? 1 : 0, 1>>();
// ── `create.filled` naming another layer leaves this layer's required columns required ──
type Line = NonNullable<CreateTree<'orders'>['lines']>[number];
is<Eq<{} extends Pick<Line, 'item'> ? 1 : 0, 0>>();
