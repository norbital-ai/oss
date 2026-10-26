// Type corpus for access (§3.3.7, §3.9, rules 33–38c, spec §8). Each `@ts-expect-error` line is a planted mistake; a
// clean tsc proves every valid literal compiles and every mistake is refused at its literal.
import { policy } from '../../src/index.ts';
import type {
	Actor,
	ApprovalWrite,
	Edge,
	Flow,
	Grant,
	Id,
	LimitKey,
	Row,
	TeamName,
	WriteField
} from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <T extends true>(): T => true as T;

is<Eq<Edge<'orders', 'status'>, 'draft->submitted' | 'submitted->ordered' | 'submitted->draft'>>();
is<Eq<WriteField<'orders', 'create'>, 'customer' | 'note' | 'due' | 'lines'>>();
is<Eq<WriteField<'orders', 'update'>, 'status' | 'note' | 'due' | 'placed_at' | 'lines'>>();
is<Eq<Extract<LimitKey, `orders.${string}`>, 'orders.open_total'>>();
is<Eq<'create' extends keyof Exclude<Grant<'notices'>, { via: unknown }> ? 1 : 0, 1>>(); // writable unless a sync owns it at run time
is<Eq<TeamName, 'finance' | 'sales'>>();
// the write an approval judges, typed from the model: `previous` only on an update
is<Eq<ApprovalWrite<'orders', 'update'>['previous'], Row<'orders'>>>();
is<Eq<ApprovalWrite<'orders', 'create'>['previous'], null>>();
is<
	Eq<Extract<ApprovalWrite<'orders'>['changed'][number], 'lines' | 'unknown_relation'>, 'lines'>
>();
is<
	Eq<
		ApprovalWrite<'orders'>['requester'],
		{ readonly id: Id<'sys_user'>; readonly team: TeamName | null } | null
	>
>();

// ── valid: today's template behaviour as literals ──
const ownOrders = { owner: { eq: { actor: 'id' } } } as const;
export const salesRep = policy({
	description: 'Sell to our customers',
	grants: {
		orders: {
			read: ownOrders,
			history: true,
			create: {
				where: { customer: { is: { tier: { eq: 'gold' } } } },
				fields: ['customer', 'note', 'lines'],
				// steps in order; `if` adds one only when it holds; finance may decide in any step's place
				approval: (write, flow) =>
					flow
						.step('Sales review', { teams: ['sales'] })
						.if(write.record.note !== null, (f) =>
							f.step('Finance sign-off', { teams: ['finance'] })
						)
						.supersededBy(['finance'])
			},
			update: {
				where: 'read',
				previous: { status: { in: ['draft', 'submitted'] } },
				fields: ['status', 'note'],
				// the owner approves their own order's status change; a wording fix needs no approval
				approval: (write, flow) => {
					if (!write.changed.includes('status')) return flow.allow();
					const owner = write.record.owner;
					return owner === null
						? flow.step('Finance', { teams: ['finance'] })
						: flow.step('Owner', { users: [owner] }).step('Finance', { teams: ['finance'] });
				}
			},
			delete: {
				where: { status: { eq: 'draft' } },
				approval: (write, flow) =>
					write.requester?.team === 'finance'
						? flow.allow()
						: flow.step('Finance', { teams: ['finance'] })
			},
			queries: ['open_total'],
			moves: { status: ['draft->submitted', 'submitted->draft'] }
		},
		order_lines: { via: 'order' },
		customers: {
			read: { where: { orders: { some: ownOrders } }, fields: ['name', 'tier'] },
			update: 'read',
			queries: ['gold']
		},
		notices: { read: true },
		sites: {
			read: {
				where: { customer: { in: { actor: { scopes: 'sales_rep' } } } },
				fields: ['name', 'open']
			}
		},
		sys_user: { read: { team: { in: { actor: 'teamTree' } } }, fields: ['name', 'email'] }
	},
	automations: ['nightly', 'products.sync.ledger', 'orders_submit', 'orders_renote'],
	capabilities: { apps: ['sales'], tools: ['browser'], mcp: ['erp'], skills: ['quoting'] },
	limits: {
		act: '600/min',
		agent: { rate: '100/h', per: 'actor' },
		read: [
			{ rate: '3000/min', per: 'actor' },
			{ rate: '600/min', per: 'ip' }
		],
		convert: '10/min',
		'customers.gold': { rate: '1/15min', per: 'actor' },
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
		customers: { read: { where: { tier: { eq: 'gold' } }, fields: ['name'] } },
		orders: { create: { customer: { is: { tier: { eq: 'gold' } } } } }
	},
	limits: { register: { rate: '10/h', per: 'ip' } }
});
// A kiosk-style pre-image scope (`previous` + `where`), and `moves: 'all'`.
export const clerk = policy({
	description: 'Place orders',
	grants: {
		orders: {
			update: {
				previous: { placed_at: { isNull: true } },
				where: { placed_at: { isNull: false } }
			},
			moves: 'all'
		}
	}
});
// the approval callback is part of the literal policy() returns
is<
	Eq<
		typeof salesRep.grants.orders.update.approval,
		(write: ApprovalWrite<'orders', 'update'>, flow: Flow) => Flow
	>
>();

// ── grants ──
// @ts-expect-error A1 an unknown collection
// prettier-ignore
policy({ description: 'x', grants: { oders: { read: true } } });
// @ts-expect-error A1 teams are source declarations, never a grantable collection
// prettier-ignore
policy({ description: 'x', grants: { sys_team: { read: true } } });
// @ts-expect-error A2 a read field the collection does not expose (sites reads six fields)
// prettier-ignore
policy({ description: 'x', grants: { sites: { read: { fields: ['zone'] } } } });
// @ts-expect-error A3 a scope naming an unknown field
// prettier-ignore
policy({ description: 'x', grants: { orders: { read: { nope: { eq: 1 } } } } });
// @ts-expect-error A4 a create field outside the create allowlist
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { fields: ['status'] } } } });
// @ts-expect-error A5 `'read'` in a grant that has no `read`
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: 'read' } } });
// @ts-expect-error A6 `previous` on a create grant (update only)
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { previous: true } } } });
// @ts-expect-error A7 `via` is exclusive
// prettier-ignore
policy({ description: 'x', grants: { order_lines: { via: 'order', read: true } } });
// @ts-expect-error A8 `via` must name a one-relation (lines is a many-relation of orders)
// prettier-ignore
policy({ description: 'x', grants: { orders: { via: 'lines' } } });
// @ts-expect-error A9 a move along an undeclared edge
// prettier-ignore
policy({ description: 'x', grants: { orders: { moves: { status: ['draft->ordered'] } } } });
// @ts-expect-error A10 moves on a field that is not a state
// prettier-ignore
policy({ description: 'x', grants: { orders: { moves: { note: ['a->b'] } } } });
// @ts-expect-error A11 a query of another collection
// prettier-ignore
policy({ description: 'x', grants: { orders: { queries: ['gold'] } } });
// @ts-expect-error A12 an automation the workspace does not declare
// prettier-ignore
policy({ description: 'x', grants: {}, automations: ['orders_ship'] });
// @ts-expect-error A13 `erase` is admin-only, never grantable (rule 38e)
// prettier-ignore
policy({ description: 'x', grants: { orders: { erase: true } } });
// @ts-expect-error A14 a create grant on a model that declares no create
// prettier-ignore
policy({ description: 'x', grants: { products: { read: true, create: { fields: ['name'] } } } });
// @ts-expect-error A16 identity-field-write: sys_user grants read only
// prettier-ignore
policy({ description: 'x', grants: { sys_user: { read: true, update: { fields: ['name'] } } } });
// @ts-expect-error A17 `'read'` is not a delete scope
// prettier-ignore
policy({ description: 'x', grants: { orders: { read: true, delete: 'read' } } });
// @ts-expect-error A18 an unknown grant key
// prettier-ignore
policy({ description: 'x', grants: { orders: { mutate: true } } });

// ── approval flows on the write grant (spec §8) ──
policy({
	description: 'x',
	grants: {
		orders: {
			update: {
				// a step decided by named members, then `else` when the condition fails
				approval: (write, flow) =>
					flow
						.if(write.previous.status === 'draft', (f) => f.step('Sales', { teams: ['sales'] }))
						.else((f) => f.deny('Only a draft changes under approval.'))
			}
		}
	}
});
policy({
	description: 'x',
	grants: {
		orders: {
			// @ts-expect-error AP1 approval on a read grant
			read: { approval: (_w: unknown, flow: Flow) => flow.allow() }
		}
	}
});
// @ts-expect-error AP2 a step naming an undeclared team
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { approval: (_, flow) => flow.step('x', { teams: ['legal'] }) } } } });
// @ts-expect-error AP3 the callback returns the flow, nothing else
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { approval: () => true } } } });
// @ts-expect-error AP4 a create has no previous row
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { approval: (write, flow) => (write.previous.note === null ? flow.allow() : flow.deny('x')) } } } });
// @ts-expect-error AP5 `changed` names the model's fields
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { approval: (write, flow) => (write.changed.includes('nte') ? flow.allow() : flow.deny('x')) } } } });
// @ts-expect-error AP6 a superseder is a declared team
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { approval: (_, flow) => flow.step('x', { teams: ['sales'] }).supersededBy(['board']) } } } });
// @ts-expect-error AP7 `else` follows `if` only
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { approval: (_, flow) => flow.step('x', { teams: ['sales'] }).else((f) => f) } } } });
// @ts-expect-error AP8 a user approver is a member id, not a handle
// prettier-ignore
policy({ description: 'x', grants: { orders: { update: { approval: (_, flow) => flow.step('x', { users: ['bob'] }) } } } });
// @ts-expect-error AP11 a record field the model lacks
// prettier-ignore
policy({ description: 'x', grants: { orders: { create: { approval: (write, flow) => (write.record.amount === null ? flow.allow() : flow.deny('x')) } } } });

// ── the policy, capabilities and limits ──
// @ts-expect-error A29 a policy without a description
// prettier-ignore
policy({ grants: {} });
// @ts-expect-error A30 an unknown top-level key
// prettier-ignore
policy({ description: 'x', grants: {}, elevate: true });
// @ts-expect-error A31 an unknown automation
// prettier-ignore
policy({ description: 'x', grants: {}, automations: ['nightley'] });
// @ts-expect-error A32 a sync run the model does not declare (sheet is a file sync; ledger on orders only writes)
// prettier-ignore
policy({ description: 'x', grants: {}, automations: ['orders.sync.ledger'] });
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
// @ts-expect-error A36 an undeclared query limit key
// prettier-ignore
policy({ description: 'x', grants: {}, limits: { 'orders.unknown_query': '1/min' } });
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
	teamPath: ['sales'],
	admin: false,
	party: null
};
const envoy: Actor = {
	kind: 'envoy',
	envoy: 'desk',
	instance: 'whatsapp' as Id<'sys_integration'>,
	sender: '+6590000000',
	member: null
};
const run: Actor = {
	kind: 'system',
	run: '' as Id<'sys_run'>,
	by: { platform: 'bolt.notify' }
};
// a sync's own writes run as the sync for one instance (never sent back through it)
const synced: Actor = {
	kind: 'system',
	run: '' as Id<'sys_run'>,
	by: { sync: 'products.sync.ledger', instance: '' as Id<'sys_integration'> }
};
void member;
void envoy;
void run;
void synced;
// @ts-expect-error A41 a non-string team display path
// prettier-ignore
const a1: Actor = { kind: 'member', id: '' as Id<'sys_user'>, email: null, phone: null, external: false, teams: [], teamPath: [42], admin: false, party: null };
// @ts-expect-error A42 an undeclared envoy
// prettier-ignore
const a2: Actor = { kind: 'envoy', envoy: 'dsk', instance: 'whatsapp' as Id<'sys_integration'>, sender: 'x', member: null };
// @ts-expect-error A43 a visitor of an unknown app
// prettier-ignore
const a3: Actor = { kind: 'visitor', app: 'careers', visitor: 'v' };
void a1;
void a2;
void a3;
