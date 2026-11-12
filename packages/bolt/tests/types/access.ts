import { id_of } from '../../src/decl/id.ts';
import { Schema } from 'effect';
// Type corpus for access (§3.3.7, §3.9, rules 33–38c, spec §8). Each `@ts-expect-error` line is a planted mistake; a
// clean tsc proves every valid literal compiles and every mistake is refused at its literal.
import { policy } from '../../src/index.ts';
import type {
	Actor,
	CreateVerdict,
	Edge,
	Grant,
	Id,
	LimitKey,
	TeamName,
	UpdateVerdict,
	WriteField
} from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(..._proof: T extends true ? [] : never): void => {};

is<Eq<Edge<'orders', 'status'>, 'draft->submitted' | 'submitted->ordered' | 'submitted->draft'>>();
// a write grant's root columns are the model's declared root columns; a layer is its own path, never a column
is<Eq<WriteField<'orders', 'create'>, 'customer' | 'note' | 'due'>>();
is<Eq<WriteField<'orders', 'update'>, 'status' | 'note' | 'due' | 'placed_at'>>();
is<Eq<WriteField<'orders', 'create', 'orders.lines'>, 'item' | 'qty' | 'price'>>();
// no declared queries: no `'<model>.<query>'` limit keys
is<Eq<Extract<LimitKey, `orders.${string}`>, never>>();
is<Eq<'outputs' extends keyof Grant<'notices'> ? 1 : 0, 1>>();
is<Eq<TeamName, 'finance' | 'sales'>>();

// ── valid: today's template behaviour as literals ──
const ownOrders = { owner: { eq: { var: 'requestor.id' } } } as const;
export const salesRep = policy({
	description: 'Sell to our customers',
	grants: {
		orders: {
			outputs: { default: { history: true, where: ownOrders } },
			create: {
				columns: { fields: ['customer', 'note'], lines: { fields: ['item', 'qty'] } },
				// one read over the batch replaces the old relation-hop `where`; steps in order, `if` adds one only when it
				// holds, finance may decide in any step's place
				verdict: function* (rows, ctx) {
					const { customers } = yield* ctx.query({
						customers: { where: { id: { in: rows.map((r) => r.after.customer) } }, fields: ['tier'] }
					});
					if (customers.rows.some((c) => c.tier !== 'gold'))
						return yield* ctx.refuse('Gold customers only.', { field: 'customer' });
					return ctx.approve({
						steps: [
							{ name: 'Sales review', teams: ['sales'] },
							...(rows.some((row) => row.after.note != null)
								? [{ name: 'Finance sign-off', teams: ['finance'] as const }]
								: [])
						],
						superseded_by: ['finance']
					});
				}
			},
			update: {
				columns: { fields: ['status', 'note'] },
				moves: { status: ['draft->submitted', 'submitted->draft'] },
				// the pre-image check `previous` was; the owner's team reviews a status change
				verdict: function* (changes, ctx) {
					if (changes.some((c) => c.before.status === 'ordered'))
						return yield* ctx.refuse('An ordered order stays.', { field: 'status' });
					if (changes.every((c) => c.set.status === undefined)) return ctx.allow();
					const owner = changes[0]?.before.owner ?? null;
					const finance = { name: 'Finance', teams: ['finance'] } as const;
					return ctx.approve({
						steps: owner === null ? [finance] : [{ name: 'Owner team', teams: ['sales'] }, finance]
					});
				}
			},
			delete: {
				verdict: function* (rows, ctx) {
					if (rows.some((r) => r.before.status !== 'draft'))
						return yield* ctx.refuse('Only drafts are deleted.', { row: 0 });
					return ctx.actor.kind === 'member' && ctx.actor.teams.includes('finance')
						? ctx.allow()
						: ctx.approve({ steps: [{ name: 'Finance', teams: ['finance'] }] });
				}
			}
		},
		// a narrow named output: the shape is the model's, the grant only filters rows
		customers: {
			outputs: { directory: { where: { orders: { some: ownOrders } } } },
			update: true
		},
		notices: { outputs: { default: true } },
		sites: {
			outputs: { summary: { where: { customer: { in: { var: 'requestor.scopes.sales_rep' } } } } }
		},
		sys_user: { outputs: { directory: { where: { team: { in: { var: 'requestor.team_tree' } } } } } }
	},
	capabilities: {
		apps: ['sales'],
		tools: ['browser'],
		mcp: ['erp'],
		automations: ['nightly', 'orders_submit', 'orders_renote'],
		syncs: ['products.ledger']
	},
	limits: {
		act: '600/min',
		agent: { rate: '100/h', per: 'actor' },
		read: [
			{ rate: '3000/min', per: 'actor' },
			{ rate: '600/min', per: 'ip' }
		],
		convert: '10/min',
		'envoys.receive': [
			{ rate: '8/min', per: 'sender' },
			{ rate: '300/min', per: 'subject' }
		],
		'envoys.unrecognised': '1/15min'
	}
});
// A visitor policy (rule 38d): the shape is ordinary; what a public policy may hold is the build's `access/visitor-grant`.
export const applicant = policy({
	description: 'Anyone may apply',
	grants: {
		customers: { outputs: { directory: { where: { tier: { eq: 'gold' } } } } },
		orders: { create: { columns: { fields: ['customer'] } } }
	},
	limits: { register: { rate: '10/h', per: 'ip' } }
});
// A kiosk-style pre-image scope (once `previous` + `where`) is the update check over `before` and `set`; `moves: 'all'`.
export const clerk = policy({
	description: 'Place orders',
	grants: {
		orders: {
			update: {
				moves: 'all',
				verdict: function* (changes, ctx) {
					return changes.every((c) => c.before.placed_at === null && c.set.placed_at != null)
						? ctx.allow()
						: yield* ctx.refuse('Place an unplaced order.', { field: 'placed_at' });
				}
			}
		}
	}
});
// the check callbacks are part of the literal policy() returns, typed from the model's declaration
export const createCheck: CreateVerdict<'orders'> = salesRep.grants.orders.create.verdict;
export const updateCheck: UpdateVerdict<'orders'> = salesRep.grants.orders.update.verdict;

// ── grants ──
// @ts-expect-error A1 an unknown model
// prettier-ignore
policy({ description: 'x', grants: { oders: { outputs: { default: true } } } });
// @ts-expect-error A1 teams are source declarations, never a grantable model
// prettier-ignore
policy({ description: 'x', grants: { sys_team: { outputs: { default: true } } } });
// @ts-expect-error A2 a read grant never names fields: the output's shape is the model's
// prettier-ignore
policy({ description: 'x', grants: { sites: { outputs: { default: { sites: { fields: ['name'] } } } } } });
// @ts-expect-error A2b nor does a named output's grant
// prettier-ignore
policy({ description: 'x', grants: { sites: { outputs: { summary: { sites: { fields: ['name'] } } } } } });
// @ts-expect-error A2c an output the model does not declare
// prettier-ignore
policy({ description: 'x', grants: { sites: { outputs: { full: true } } } });
// The default output uses the same grant form as named outputs.
// prettier-ignore
policy({ description: 'x', grants: { sites: { outputs: { default: true } } } });
// @ts-expect-error A2e a grant path outside its output (logistics has no orders.customer layer)
// prettier-ignore
policy({ description: 'x', grants: { orders: { outputs: { logistics: { customer: { where: { tier: { eq: 'gold' } } } } } } } });
// @ts-expect-error A2f a history-enabled output grants its model-defined shape
// prettier-ignore
policy({ description: 'x', grants: { orders: { outputs: { default: { history: true, where: { note: { is_null: true } }, fields: ['note'] } } } } });
// @ts-expect-error A2g an identity grant names no fields beside its read
// prettier-ignore
policy({ description: 'x', grants: { sys_user: { outputs: { default: true }, fields: ['name'] } } });
// a named output's layer filter names that output's paths
policy({
	description: 'x',
	grants: { orders: { outputs: { logistics: { lines: { where: { qty: { gt: 0 } } } } } } }
});
// @ts-expect-error A3 a layer scope naming an unknown field
// prettier-ignore
policy({ description: 'x', grants: { orders: { outputs: { default: { where: { nope: { eq: 1 } } } } } } });
// @ts-expect-error A3b a bare `Where` is wrapped in the output's `where`
// prettier-ignore
policy({ description: 'x', grants: { orders: { outputs: { default: { owner: { eq: { var: 'requestor.id' } } } } } } });
// @ts-expect-error A4 a create column outside the declared create columns
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { columns: { fields: ['status'] } } } } });
// @ts-expect-error A5 the `'read'` write shorthand is gone
// prettier-ignore
policy({ description: 'x', grants: { orders: { outputs: { default: true }, update: 'read' } } });
// @ts-expect-error A6 `previous` is gone: the update check judges `before`
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { previous: { status: { eq: 'draft' } } } } } });
// @ts-expect-error A6b a write `where` is gone: the check reads what it needs
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { where: { note: { is_null: true } } } } } });
// @ts-expect-error A7 `via` is gone: a child is a layer of its root (decision 3)
// prettier-ignore
policy({ description: 'x', grants: { order_lines: { via: 'order' } } });
// @ts-expect-error A8 a write layer is a declared write path (orders.customer is a read layer only)
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { columns: { customer: { fields: ['name'] } } } } } });
// @ts-expect-error A9 a move along an undeclared edge
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { moves: { status: ['draft->ordered'] } } } } });
// @ts-expect-error A10 moves on a field that is not a state
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { moves: { note: ['a->b'] } } } } });
// @ts-expect-error A11 policy `queries` are gone with declared queries
// prettier-ignore
policy({ description: 'x', grants: { orders: { queries: ['open_total'] } } });
// @ts-expect-error A12 an automation the workspace does not declare
// prettier-ignore
policy({ description: 'x', grants: {}, capabilities: { automations: ['orders_ship'] } });
// @ts-expect-error A13 `erase` is admin-only, never grantable (rule 38e)
// prettier-ignore
policy({ description: 'x', grants: { orders: { erase: true } } });
// @ts-expect-error A14 a create grant on a model that declares no create
// prettier-ignore
policy({ description: 'x', grants: { products: { outputs: { default: true }, create: true } } });
// @ts-expect-error A15 a sync-owned model without a declared create takes no create grant
// prettier-ignore
policy({ description: 'x', grants: { notices: { outputs: { default: true }, create: true } } });
// @ts-expect-error A16 identity-field-write: sys_user grants read only
// prettier-ignore
policy({ description: 'x', grants: { sys_user: { outputs: { default: true }, update: true } } });
// @ts-expect-error A17 `'read'` is not a delete scope
// prettier-ignore
policy({ description: 'x', grants: { orders: { outputs: { default: true }, delete: 'read' } } });
// @ts-expect-error A18 an unknown grant key
// prettier-ignore
policy({ description: 'x', grants: { orders: { mutate: true } } });

// ── verdicts and approval flows of a write check (spec §8) ──
policy({
	description: 'x',
	grants: {
		orders: {
			update: {
				// A named team decides when the condition holds.
				verdict: function* (changes, ctx) {
					return changes[0]?.before.status === 'draft'
						? ctx.approve({ steps: [{ name: 'Sales', teams: ['sales'] }] })
						: yield* ctx.refuse('Only a draft changes under approval.');
				}
			}
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			outputs: {
				// @ts-expect-error AP1 a verdict on an output grant
				default: {
					verdict: function* (_: unknown, ctx: { allow(): unknown }) {
						return ctx.allow();
					}
				}
			}
		}
	}
});
// @ts-expect-error AP2 a step naming an undeclared team
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { verdict: function* (_, ctx) { return ctx.approve({ steps: [{ name: 'x', teams: ['legal'] }] }); } } } } });
// @ts-expect-error AP3 a check returns a verdict, nothing else
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { verdict: function* () { return true; } } } } });
// @ts-expect-error AP3b a plain object is no verdict
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { verdict: function* () { return { kind: 'allow' }; } } } } });
// @ts-expect-error AP5 `set` names the declared update columns
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { verdict: function* (changes, ctx) { return changes[0]?.set.nte === undefined ? ctx.allow() : yield* ctx.refuse('x'); } } } } });
// @ts-expect-error AP6 a superseder is a declared team
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { verdict: function* (_, ctx) { return ctx.approve({ steps: [{ name: 'x', teams: ['sales'] }], superseded_by: ['board'] }); } } } } });
// @ts-expect-error AP7 a flow needs at least one step
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { verdict: function* (_, ctx) { return ctx.approve({ steps: [] }); } } } } });
// @ts-expect-error AP8 approval steps accept teams
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { verdict: function* (_, ctx) { return ctx.approve({ steps: [{ name: 'x', users: ['bob'] }] }); } } } } });
// @ts-expect-error AP11 a row field the model lacks
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { verdict: function* (rows, ctx) { return rows[0]?.after.amount === null ? ctx.allow() : yield* ctx.refuse('x'); } } } } });
// @ts-expect-error AP12 `deny`'s path is a declared write path
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { verdict: function* (_, ctx) { return yield* ctx.refuse('x', { path: 'orders.customer' }); } } } } });
// @ts-expect-error AP13 a check's ctx holds no `act`
// prettier-ignore
policy({ description: 'x', grants: { orders: { delete: { verdict: function* (_, ctx) { yield* ctx.act({ 'orders.delete': [] }); return ctx.allow(); } } } } });

// ── the policy, capabilities and limits ──
// @ts-expect-error A29 a policy without a description
// prettier-ignore
policy({ grants: {} });
// @ts-expect-error A30 an unknown top-level key
// prettier-ignore
policy({ description: 'x', grants: {}, elevate: true });
// @ts-expect-error A31 an unknown automation
// prettier-ignore
policy({ description: 'x', grants: {}, capabilities: { automations: ['nightley'] } });
// @ts-expect-error A32 a sync run the model does not declare (sheet is a file sync; ledger on orders only writes)
// prettier-ignore
policy({ description: 'x', grants: {}, capabilities: { syncs: ['orders.ledger'] } });
// a group name covers every app under it (`canOpen`'s `<group>/` prefix)
policy({ description: 'x', grants: {}, capabilities: { apps: ['ops'] } });
// @ts-expect-error A33 an unknown app
// prettier-ignore
policy({ description: 'x', grants: {}, capabilities: { apps: ['crm'] } });
// @ts-expect-error A34 an unknown MCP server
// prettier-ignore
policy({ description: 'x', grants: {}, capabilities: { mcp: ['sap'] } });
// @ts-expect-error A35 an unknown limit key
// prettier-ignore
policy({ description: 'x', grants: {}, limits: { unknown_limit: '600/min' } });
// @ts-expect-error A36 a `'<model>.<query>'` limit key is gone with declared queries
// prettier-ignore
policy({ description: 'x', grants: {}, limits: { 'orders.open_total': '1/min' } });
// @ts-expect-error A37 a rate outside the grammar
// prettier-ignore
policy({ description: 'x', grants: {}, limits: { act: '600/week' } });
// @ts-expect-error A38 `per: 'sender'` on a non-envoy key
// prettier-ignore
policy({ description: 'x', grants: {}, limits: { act: { rate: '1/s', per: 'sender' } } });
// @ts-expect-error A39 `per: 'ip'` on an envoy key
// prettier-ignore
policy({ description: 'x', grants: {}, limits: { 'envoys.receive': { rate: '1/s', per: 'ip' } } });
// @ts-expect-error A40 `per: 'surface'` does not exist
// prettier-ignore
policy({ description: 'x', grants: {}, limits: { read: { rate: '1/s', per: 'surface' } } });

// ── Actor (§3.9) ──
const member: Actor = {
	kind: 'member',
	id: '' as Id<'sys_user'>,
	email: null,
	phone: null,
	external: false,
	teams: [],
	team_path: ['sales'],
	admin: false,
	party: null
};
const envoy: Actor = {
	kind: 'envoy',
	envoy: Schema.decodeUnknownSync(id_of('sys_envoy'))('0199a000-0000-7000-8000-0000000000e1'),
	instance: 'whatsapp' as Id<'sys_integration'>,
	sender: '+6590000000',
	member: null
};
const run: Actor = {
	kind: 'system',
	run: '' as Id<'sys_run'>,
	by: { platform: 'notifications.deliver' }
};
// a sync's own writes run as the sync for one instance (never sent back through it)
const synced: Actor = {
	kind: 'system',
	run: '' as Id<'sys_run'>,
	by: { sync: 'products.sync.ledger', instance: '' as Id<'sys_integration'> }
};
// an automation run: the system identity; who started it is the run's trigger, never its actor
const automationRun: Actor = {
	kind: 'system',
	run: '' as Id<'sys_run'>,
	by: { automation: 'orders_submit' }
};
// @ts-expect-error A40a a run's actor carries no requestor
// prettier-ignore
const startedRun: Actor = { kind: 'system', run: '' as Id<'sys_run'>, by: { automation: 'orders_submit' }, requestor: member };
void startedRun;
void member;
void envoy;
void run;
void synced;
void automationRun;
// @ts-expect-error A41 a non-string team display path
// prettier-ignore
const a1: Actor = { kind: 'member', id: '' as Id<'sys_user'>, email: null, phone: null, external: false, teams: [], team_path: [42], admin: false, party: null };
// @ts-expect-error A42 an undeclared envoy
// prettier-ignore
const a2: Actor = { kind: 'envoy', envoy: 'dsk', instance: 'whatsapp' as Id<'sys_integration'>, sender: 'x', member: null };
// @ts-expect-error A43 a visitor of an unknown app
// prettier-ignore
const a3: Actor = { kind: 'visitor', app: 'careers', visitor: 'v' };
void a1;
void a2;
void a3;
