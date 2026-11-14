// Type corpus for layer-map policies (decision 3, plan "Type safety of the policy"): everything a grant says is typed from
// the model's own declaration. Each `@ts-expect-error` line is a planted mistake from the plan's table; a clean tsc proves
// every valid literal compiles and every mistake is refused at its literal.
import { policy } from '../../src/index.ts';
import type { CreateInput, StoredTree, UpdateInput } from '../../src/index.ts';
import './registry.ts';
import type { LayerField, OutputName, PathModel, ReadPath, WritePath } from '../../src/decl/names.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};
type System = 'id' | 'revision' | 'created_at' | 'updated_at' | 'created_by' | 'updated_by';

// ── the generated path unions and the model behind each path ──
is<Eq<ReadPath<'orders'>, 'orders' | 'orders.customer' | 'orders.lines'>>();
is<Eq<WritePath<'orders', 'create'>, 'orders' | 'orders.lines'>>();
is<Eq<PathModel<'orders', 'orders.lines'>, 'order_lines'>>();
is<Eq<PathModel<'orders', 'orders'>, 'orders'>>();
is<Eq<Exclude<LayerField<'orders', 'orders.customer'>, System>, 'name' | 'tier'>>();
// a named output's paths and fields are its own declaration
is<Eq<OutputName<'orders'>, 'default' | 'logistics'>>();
is<Eq<ReadPath<'orders', 'logistics'>, 'orders' | 'orders.lines'>>();
is<Eq<Exclude<LayerField<'orders', 'orders.lines', 'logistics'>, System>, 'item' | 'qty'>>();
// ── the trees a check judges ──
is<Eq<keyof CreateInput<'orders'>, 'customer' | 'note' | 'due' | 'lines'>>();
is<Eq<keyof NonNullable<CreateInput<'orders'>['lines']>[number], 'item' | 'qty' | 'price'>>();
is<Eq<keyof UpdateInput<'orders'>, 'status' | 'note' | 'due' | 'placed_at' | 'lines'>>();
is<Eq<'lines' extends keyof StoredTree<'orders', 'update'> ? 1 : 0, 1>>();

// ── valid ──
export const layered = policy({
	description: 'Sell to our customers, through the order tree',
	grants: {
		orders: {
			outputs: {
				default: {
					history: true,
					where: { owner: { eq: { var: 'actor.id' } } },
					customer: { where: { tier: { eq: 'gold' } } },
					lines: { where: { item: { ne: '' } } }
				},
				logistics: { where: { status: { ne: 'draft' } } }
			},
			create: {
				fields: ['customer', 'note'],
				lines: { fields: ['item', 'qty'] },
				verdict: function* (rows, ctx) {
					const bad = rows.findIndex((o) => (o.after.lines ?? []).some((l) => l.item === ''));
					if (bad >= 0)
						return yield* ctx.refuse('errors.refused', { row: bad });
					const { customers } = yield* ctx.query({
						customers: { where: { id: { in: rows.map((r) => r.after.customer) } }, fields: ['tier'] }
					});
					return customers.rows.every((c) => c.tier === 'gold')
						? ctx.allow()
						: ctx.approve({ steps: [{ name: 'Sales review', teams: ['sales'] }] });
				}
			},
			update: {
				fields: ['status', 'note'],
				verdict: function* (changes, ctx) {
					const me = ctx.actor.kind === 'member' ? ctx.actor.id : null;
					const mine = changes.every((c) => c.before.owner === me && c.before.lines.length < 100);
					return mine
						? ctx.allow()
						: yield* ctx.refuse('errors.refused', { field: 'status' });
				}
			},
			delete: {
				verdict: function* (rows, ctx) {
					return rows.length < 10
						? ctx.allow()
						: yield* ctx.refuse('errors.refused', { row: 0 });
				}
			}
		},
		notices: { outputs: { default: {} } },
		customers: { update: {} }
	}
});

// ── refused: each line one row of the plan's table ──
policy({
	description: 'x',
	// @ts-expect-error a read layer the model does not declare (`owner` is a relation, never a layer)
	grants: { orders: { outputs: { default: { owner: {} } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a layer filter on a field of another layer (`note` is the root's)
	grants: { orders: { outputs: { default: { customer: { where: { note: { is_null: true } } } } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a column the model's create does not declare
	grants: { orders: { create: { fields: ['status'] } } }
});
policy({
	description: 'x',
	// @ts-expect-error a write path the model's create does not declare
	grants: { orders: { create: { fields: ['customer'], customer: { fields: ['name'] } } } }
});
policy({
	description: 'x',
	// @ts-expect-error a verb the model does not declare (sites declares no create)
	grants: { sites: { create: {} } }
});
policy({
	description: 'x',
	// @ts-expect-error `read` on a model without `read`
	grants: { sys_session: { outputs: { default: {} } } }
});
policy({
	description: 'x',
	// @ts-expect-error a write grant's `where` is gone: judge the batch in `check`
	grants: { orders: { update: { where: { status: { eq: 'draft' } } } } }
});
policy({
	description: 'x',
	grants: {
		orders: {
			delete: {
				// @ts-expect-error an unknown ctx member
				verdict: function* (_rows, ctx) {
					return ctx.refuse('errors.refused');
				}
			}
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			delete: {
				// @ts-expect-error a plain-object verdict
				verdict: function* () {
					return { kind: 'allow' };
				}
			}
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			create: {
				verdict: function* (_rows, ctx) {
					// @ts-expect-error a refusal names a row and a root column, never a write path
					return yield* ctx.refuse('errors.refused', { path: 'orders.lines' });
				}
			}
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			create: {
				verdict: function* (_rows, ctx) {
					// @ts-expect-error `field` is a root column of the verb
					return yield* ctx.refuse('errors.refused', { field: 'item' });
				}
			}
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			create: {
				// @ts-expect-error a mistyped `check` argument
				verdict: function* (_rows: readonly { readonly nope: 1 }[], ctx) {
					return ctx.allow();
				}
			}
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			create: {
				verdict: function* (rows, ctx) {
					// @ts-expect-error a relation the create does not declare is not in its rows
					return rows[0]?.after.notes === undefined ? ctx.allow() : ctx.allow();
				}
			}
		}
	}
});
policy({
	description: 'x',
	// @ts-expect-error policy `queries` and `via` are gone
	grants: { orders: { queries: ['open_total'] }, order_lines: { via: 'order' } }
});

// ── `create.filled` naming another layer leaves this layer's required columns required ──
type Line = NonNullable<CreateInput<'orders'>['lines']>[number];
is<Eq<{} extends Pick<Line, 'item'> ? 1 : 0, 0>>();
