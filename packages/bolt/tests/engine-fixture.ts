// The integration workspace: customers ← orders (a seq, a state with a per-state `edit`, a roll-up) → owned lines; a
// transform on orders that reads the customer and refuses a blocked one; two policies, `rep` (own rows, north only on
// write) and `auditor` (every row, `note` narrowed away, so a caller holding both sees `note` masked on others' rows).
import type { EngineManifest } from '../src/engine/contracts.ts';

const lineCols = { columns: ['label', 'amount'] };
export const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		customers: { description: 'A customer', label: 'name', unique: [{ fields: ['name'] }],
			fields: { name: { kind: 'text' }, blocked: { kind: 'bool', default: false } } },
		orders: {
			description: 'An order', label: 'title',
			fields: {
				title: { kind: 'text' },
				region: { kind: 'enum', values: ['north', 'south'] },
				number: { kind: 'seq', pattern: 'SO-{0000}' },
				status: { kind: 'state', initial: 'draft', states: { draft: { to: ['submitted'] }, submitted: { to: ['draft'], edit: ['note'] } } },
				note: { kind: 'text', optional: true },
				total: { kind: 'sum', of: 'lines.amount' },
			},
		},
		lines: { description: 'A line', label: 'label', fields: { label: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } } },
	},
	relationships: {
		'orders.customer': { to: 'customers', inverse: 'orders' },
		'lines.order': { to: 'orders', inverse: 'lines', owned: true },
	},
	collections: {
		customers: { read: { fields: 'all' }, create: { input: { columns: ['name', 'blocked'] } } },
		orders: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'region', 'note', 'customer'], with: { lines: { create: lineCols } } } },
			update: { input: { columns: ['title', 'region', 'note', 'status'], with: { lines: { create: lineCols, update: lineCols, delete: {} } } } },
			delete: {},
		},
		lines: { read: { fields: 'all' }, update: { input: lineCols } },
	},
	integrations: {}, pipelines: {},
	policies: {
		rep: { description: 'Sales rep', grants: {
			customers: { read: true },
			orders: { read: { where: { created_by: { eq: { actor: 'id' } } } }, create: { where: { region: { eq: 'north' } } },
				update: { where: { region: { eq: 'north' } } }, delete: 'read', moves: { status: ['draft->submitted'] } },
			lines: { via: 'order' },
		} },
		auditor: { description: 'Reads every order', grants: {
			customers: { read: true },
			orders: { read: { fields: ['title', 'region', 'number', 'status', 'total', 'customer'] } },
		} },
	},
	teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {}, customFields: {}, agent: { skills: {} },
} as unknown as EngineManifest;

/** `guest.mjs`: one transform, its reads batched into one crossing (rule 12); `spin` burns CPU past the wall. */
export const guest = {
	source: `export default { collection: { orders: { bodies: { transform: async (rows, ctx) => {
		if (rows.some((r) => r.title === 'spin')) for (;;) {}
		const ids = rows.map((r, i) => r.customer ?? ctx.existing[i]?.customer ?? null);
		const found = await Promise.all(ids.map((id) => id === null ? null : ctx.db.get('customers', id)));
		found.forEach((c, i) => { if (c?.blocked) ctx.refuse(c.name + ' is blocked', { field: 'customer' }); });
		return rows.map((r) => r.title === undefined ? r : { ...r, title: r.title.trim() });
	} } } } };`,
};

export const ACME = '0199a000-0000-4000-8000-0000000000c1';
export const SHADY = '0199a000-0000-4000-8000-0000000000c2';
export const seed = { customers: [{ id: ACME, name: 'Acme', blocked: false }, { id: SHADY, name: 'Shady', blocked: true }] };
