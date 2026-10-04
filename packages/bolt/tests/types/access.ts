// Type corpus for access (§3.3.7, §3.8, §3.9, rules 33–38c). Each `@ts-expect-error` line is a planted mistake; a
// clean tsc proves every valid literal compiles and every mistake is refused at its literal.
import { policy } from '../../src/index.ts';
import type { Actor, Edge, Grant, Id, LimitKey, WriteField } from '../../src/index.ts';
import './registry.ts';

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const is = <T extends true>(): T => true as T;

is<Eq<Edge<'orders', 'status'>, 'draft->submitted' | 'submitted->ordered' | 'submitted->draft'>>();
is<Eq<WriteField<'orders', 'create'>, 'customer' | 'note' | 'due' | 'lines'>>();
is<Eq<WriteField<'orders', 'update'>, 'status' | 'note' | 'due' | 'placed_at' | 'lines'>>();
is<Eq<Extract<LimitKey, `orders.${string}`>, 'orders.open_total' | 'orders.submit' | 'orders.renote'>>();
is<Eq<'create' extends keyof Exclude<Grant<'notices'>, { via: unknown }> ? 1 : 0, 0>>();   // P14

// ── valid: today's template behaviour as literals ──
const ownOrders = { owner: { eq: { actor: 'id' } } } as const;
export const salesRep = policy({
	description: 'Sell to our customers',
	grants: {
		orders: {
			read: ownOrders,
			history: true,
			create: { where: { customer: { is: { tier: { eq: 'gold' } } } }, fields: ['customer', 'note', 'lines'] },
			update: {
				where: 'read', previous: { status: { in: ['draft', 'submitted'] } }, fields: ['status', 'note'],
				approval: [                                                                  // ordered routes: first match wins
					{ match: { previous: { status: { eq: 'draft' } }, record: { status: { eq: 'submitted' } }, changed: ['status'],
						requestor: 'in_team' }, steps: [['Sales'], ['Finance']], superceded_by: ['Finance'] },
					{ match: { or: [{ requestor: { team: ['Sales'] } }, { not: { record: { note: { isNull: true } } } }] }, steps: [['Finance', 'Sales']] },
				],
			},
			delete: { where: { status: { eq: 'draft' } }, approval: { steps: [['Finance']] } },
			queries: ['open_total'], actions: ['submit', 'renote'],
			moves: { status: ['draft->submitted', 'submitted->draft'] },
		},
		order_lines: { via: 'order' },
		customers: { read: { where: { orders: { some: ownOrders } }, fields: ['name', 'tier'] }, update: 'read', queries: ['gold'] },
		notices: { read: true },                                                          // one_way: reads only
		sites: { read: { where: { customer: { in: { actor: { scopes: 'sales_rep' } } } }, fields: ['name', 'open'] } },
		sys_user: { read: true, fields: ['name', 'email'] },
		sys_team: { read: { name: { like: 'Sales%' } } },
	},
	automations: ['nightly', 'notices.integration'],
	capabilities: { apps: ['sales'], tools: ['browser'], mcp: ['erp'], skills: ['quoting'] },
	limits: {
		act: '600/min', agent: { rate: '100/h', per: 'actor' }, read: [{ rate: '3000/min', per: 'actor' }, { rate: '600/min', per: 'ip' }],
		'orders.submit': '10/min', 'customers.gold': { rate: '1/15min', per: 'actor' },
		'envoys.receive': [{ rate: '8/min', per: 'sender' }, { rate: '300/min', per: 'subject' }], 'envoys.unrecognised': '1/15min',
	},
});
// A visitor policy (rule 38d): the shape is ordinary; what a public policy may hold is the build's `access/visitor-grant`.
export const applicant = policy({ description: 'Anyone may apply', grants: {
	customers: { read: { where: { tier: { eq: 'gold' } }, fields: ['name'] } }, orders: { create: { customer: { is: { tier: { eq: 'gold' } } } } } },
limits: { register: { rate: '10/h', per: 'ip' } } });
// A kiosk-style pre-image scope (`previous` + `where`), and `moves: 'all'`.
export const clerk = policy({ description: 'Place orders', grants: {
	orders: { update: { previous: { placed_at: { isNull: true } }, where: { placed_at: { isNull: false } } }, moves: 'all' } } });
void salesRep.grants.orders.update.approval[0].steps;

// ── grants ──
// @ts-expect-error A1 an unknown collection
policy({ description: 'x', grants: { oders: { read: true } } });
// @ts-expect-error A2 a read field the collection does not expose (sites reads four fields)
policy({ description: 'x', grants: { sites: { read: { fields: ['zone'] } } } });
// @ts-expect-error A3 a scope naming an unknown field
policy({ description: 'x', grants: { orders: { read: { nope: { eq: 1 } } } } });
// @ts-expect-error A4 a create field outside the create allowlist
policy({ description: 'x', grants: { orders: { create: { fields: ['status'] } } } });
// @ts-expect-error A5 `'read'` in a grant that has no `read`
policy({ description: 'x', grants: { orders: { update: 'read' } } });
// @ts-expect-error A6 `previous` on a create grant (update only)
policy({ description: 'x', grants: { orders: { create: { previous: true } } } });
// @ts-expect-error A7 `via` is exclusive
policy({ description: 'x', grants: { order_lines: { via: 'order', read: true } } });
// @ts-expect-error A8 `via` must name a one-relation (lines is a many-relation of orders)
policy({ description: 'x', grants: { orders: { via: 'lines' } } });
// @ts-expect-error A9 a move along an undeclared edge
policy({ description: 'x', grants: { orders: { moves: { status: ['draft->ordered'] } } } });
// @ts-expect-error A10 moves on a field that is not a state
policy({ description: 'x', grants: { orders: { moves: { note: ['a->b'] } } } });
// @ts-expect-error A11 a query of another collection
policy({ description: 'x', grants: { orders: { queries: ['gold'] } } });
// @ts-expect-error A12 an action the collection does not declare
policy({ description: 'x', grants: { orders: { actions: ['ship'] } } });
// @ts-expect-error A13 `erase` is admin-only, never grantable (rule 38e)
policy({ description: 'x', grants: { orders: { actions: ['erase'] } } });
// @ts-expect-error A14 a write grant on a one_way collection (P14)
policy({ description: 'x', grants: { notices: { read: true, create: true } } });
// @ts-expect-error A15 identity-grant-write (rule 38c)
policy({ description: 'x', grants: { sys_assignment: { create: true } } });
// @ts-expect-error A16 identity-field-write: sys_user grants read only
policy({ description: 'x', grants: { sys_user: { read: true, update: { fields: ['name'] } } } });
// @ts-expect-error A17 `'read'` is not a delete scope
policy({ description: 'x', grants: { orders: { read: true, delete: 'read' } } });
// @ts-expect-error A18 an unknown grant key
policy({ description: 'x', grants: { orders: { mutate: true } } });

// ── approval (§3.8) ──
// @ts-expect-error A19 approval on a read grant
policy({ description: 'x', grants: { orders: { read: { approval: { steps: [['Finance']] } } } } });
// @ts-expect-error A20 a misspelt approver team
policy({ description: 'x', grants: { orders: { update: { approval: { steps: [['Finanse']] } } } } });
// @ts-expect-error A21 an approval with no step
policy({ description: 'x', grants: { orders: { update: { approval: { steps: [] } } } } });
// @ts-expect-error A22 a step naming no team
policy({ description: 'x', grants: { orders: { update: { approval: { steps: [['Finance'], []] } } } } });
// @ts-expect-error A23 `match.previous` on a create route (update only)
policy({ description: 'x', grants: { orders: { create: { approval: { match: { previous: { note: { isNull: true } } }, steps: [['Finance']] } } } } });
// @ts-expect-error A24 `changed` naming an unknown field
policy({ description: 'x', grants: { orders: { update: { approval: { match: { changed: ['nte'] }, steps: [['Finance']] } } } } });
// @ts-expect-error A25 a misspelt requestor team
policy({ description: 'x', grants: { orders: { update: { approval: { match: { requestor: { team: ['Slaes'] } }, steps: [['Finance']] } } } } });
// @ts-expect-error A26 a misspelt superceded_by team
policy({ description: 'x', grants: { orders: { update: { approval: { steps: [['Finance']], superceded_by: ['Boss'] } } } } });
// @ts-expect-error A27 approval is never a state: an unknown route key
policy({ description: 'x', grants: { orders: { update: { approval: { steps: [['Finance']], state: 'approved' } } } } });
// @ts-expect-error A28 a later route in the list is checked too
policy({ description: 'x', grants: { orders: { update: { approval: [{ steps: [['Finance']] }, { steps: [['Nobody']] }] } } } });

// ── the policy, capabilities and limits ──
// @ts-expect-error A29 a policy without a description
policy({ grants: {} });
// @ts-expect-error A30 an unknown top-level key
policy({ description: 'x', grants: {}, elevate: true });
// @ts-expect-error A31 an unknown automation
policy({ description: 'x', grants: {}, automations: ['nightley'] });
// @ts-expect-error A32 the integration of a collection that has none
policy({ description: 'x', grants: {}, automations: ['orders.integration'] });
// a group name covers every app under it (`canOpen`'s `<group>/` prefix)
policy({ description: 'x', grants: {}, capabilities: { apps: ['ops'] } });
// @ts-expect-error A33 an unknown app
policy({ description: 'x', grants: {}, capabilities: { apps: ['crm'] } });
// @ts-expect-error A34 an unknown MCP server
policy({ description: 'x', grants: {}, capabilities: { mcp: ['sap'] } });
// @ts-expect-error A35 an unknown limit key (today's `collections.*`)
policy({ description: 'x', grants: {}, limits: { 'collections.*': '600/min' } });
// @ts-expect-error A36 a callable key naming an undeclared action
policy({ description: 'x', grants: {}, limits: { 'orders.ship': '1/min' } });
// @ts-expect-error A37 a rate outside the grammar
policy({ description: 'x', grants: {}, limits: { act: '600/week' } });
// @ts-expect-error A38 `per: 'sender'` on a non-envoy key
policy({ description: 'x', grants: {}, limits: { act: { rate: '1/s', per: 'sender' } } });
// @ts-expect-error A39 `per: 'ip'` on an envoy key
policy({ description: 'x', grants: {}, limits: { 'envoys.receive': { rate: '1/s', per: 'ip' } } });
// @ts-expect-error A40 `per: 'surface'` does not exist
policy({ description: 'x', grants: {}, limits: { read: { rate: '1/s', per: 'surface' } } });

// ── Actor (§3.9) ──
const member: Actor = { kind: 'member', id: '' as Id<'sys_user'>, email: null, phone: null, external: false, teams: [], teamPath: ['Sales'],
	admin: false, party: null };
const envoy: Actor = { kind: 'envoy', envoy: 'desk', channel: 'whatsapp', sender: '+6590000000', member: null };
const run: Actor = { kind: 'system', run: '' as Id<'sys_run'>, by: { platform: 'collections.resume' } };
void member; void envoy; void run;
// @ts-expect-error A41 a teamPath naming an unknown team
const a1: Actor = { kind: 'member', id: '' as Id<'sys_user'>, email: null, phone: null, external: false, teams: [], teamPath: ['Sails'], admin: false, party: null };
// Envoy identifiers come from runtime records.
const a2: Actor = { kind: 'envoy', envoy: 'dsk', channel: 'whatsapp', sender: 'x', member: null };
// @ts-expect-error A43 a visitor of an unknown app
const a3: Actor = { kind: 'visitor', app: 'careers', visitor: 'v' };
void a1; void a2; void a3;
