// The integration workspace: customers ← orders (a seq, a state with a per-state `edit`, a roll-up) → owned lines; a
// callbacks on orders that read the customer and refuse a blocked one; two policies, `rep` (own rows; its write `check`s
// keep orders in the north) and `auditor` (every row, `note` narrowed away, so a caller holding both sees `note` masked
// on others' rows). Lines are a layer of orders (read and written through it) and their own access point.
import type { EngineManifest } from '../src/engine/manifest.ts';

const lineCols = ['label', 'amount'];
export const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		customers: {
			description: 'A customer',
			label: 'name',
			unique: [{ fields: ['name'] }],
			fields: { name: { kind: 'text' }, blocked: { kind: 'bool', default: false } }
		},
		orders: {
			description: 'An order',
			label: 'title',
			fields: {
				title: { kind: 'text' },
				region: { kind: 'enum', values: ['north', 'south'] },
				number: { kind: 'seq', pattern: 'SO-{0000}' },
				status: {
					kind: 'state',
					initial: 'draft',
					states: { draft: { to: ['submitted'] }, submitted: { to: ['draft'], edit: ['note'] } }
				},
				note: { kind: 'text', optional: true },
				archived: { kind: 'bool', default: false },
				stage: {
					kind: 'enum',
					values: ['new', 'won', 'lost'],
					default: 'new',
					transitions: { new: ['won'], won: [], lost: [] }
				},
				total: { kind: 'sum', of: 'lines.amount' }
			},
			locked: { archived: { eq: true } }
		},
		lines: {
			description: 'A line',
			label: 'label',
			fields: { label: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } }
		}
	},
	relationships: {
		'orders.customer': { to: 'customers', inverse: 'orders' },
		'lines.order': { to: 'orders', inverse: 'lines', owned: true }
	},
	exposures: {
		customers: {
			read: { customers: { fields: 'all' } },
			create: { columns: { customers: ['name', 'blocked'] } }
		},
		orders: {
			read: {
				orders: { fields: 'all' },
				'orders.customer': { fields: 'all' },
				'orders.lines': { fields: 'all' }
			},
			create: {
				columns: {
					orders: ['title', 'region', 'note', 'stage', 'customer'],
					'orders.lines': lineCols
				}
			},
			update: {
				columns: {
					orders: ['title', 'region', 'note', 'status', 'archived', 'stage'],
					'orders.lines': lineCols
				}
			},
			delete: {}
		},
		lines: { read: { lines: { fields: 'all' } }, update: { columns: { lines: lineCols } } }
	},
	integrations: {},
	policies: {
		rep: {
			description: 'Sales rep',
			grants: {
				customers: { read: true },
				orders: {
					read: { orders: { where: { created_by: { eq: { actor: 'id' } } } } },
					create: { check: true },
					update: { check: true },
					delete: { check: true },
					moves: { status: ['draft->submitted'] }
				},
				lines: {
					read: { lines: { where: { order: { created_by: { eq: { actor: 'id' } } } } } },
					update: { check: true }
				}
			}
		},
		auditor: {
			description: 'Reads every order',
			grants: {
				customers: { read: true },
				orders: {
					read: { orders: { fields: ['title', 'region', 'number', 'status', 'total', 'customer'] } }
				}
			}
		}
	},
	teams: {},
	automations: {},
	connections: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

/** Explicit opt-in for fixtures that bind the guest's create and update callbacks. */
export const callbacks = {
	...manifest,
	exposures: {
		...manifest.exposures,
		orders: {
			...manifest.exposures.orders,
			create: { ...manifest.exposures.orders.create, transform: true },
			update: { ...manifest.exposures.orders.update, transform: true }
		}
	}
} satisfies EngineManifest;

/**
 * `guest.mjs`: each callback batches customer references into one query; `spin` burns CPU past the wall. `rep`'s checks
 * deny a write that leaves the north (`rule: 'rep.orders.<op>'`), a delete of another member's order, and a line change
 * on an order outside the north (one read over the batch).
 */
export const guest = {
	source: `function* checkCustomers(rows, ctx) {
	const ids = [...new Set(rows.flatMap((row) => row.customer == null ? [] : [row.customer]))];
	const customers = ids.length === 0 ? [] : (yield* ctx.db.query({ customers: { where: { id: { in: ids } } } })).customers.rows;
	for (const customer of customers) if (customer.blocked) yield* ctx.refuse(customer.name + ' is blocked', { field: 'customer' });
}
const trim = (rows) => rows.map((row) => row.title === undefined ? row : { ...row, title: row.title.trim() });
export default { model: { orders: { bodies: {
	create: function* (rows, ctx) {
		if (rows.some((row) => row.title === 'spin')) for (;;) {}
		yield* checkCustomers(rows, ctx);
		return trim(rows);
	},
	update: function* (changes, ctx) {
		if (changes.some(({ set }) => set.title === 'spin')) for (;;) {}
		yield* checkCustomers(changes.map(({ before, set }) => ({ ...before, ...set })), ctx);
		return trim(changes.map(({ set }) => set));
	}
} } },
policy: { rep: { grants: {
	orders: {
		create: { check: function* (rows, ctx) {
			const row = rows.findIndex((r) => r.region !== 'north');
			return row >= 0 ? ctx.deny('Reps sell in the north.', { row, field: 'region' }) : ctx.allow();
		} },
		update: { check: function* (changes, ctx) {
			const row = changes.findIndex(({ before, set }) => before.region !== 'north' || (set.region ?? before.region) !== 'north');
			return row >= 0 ? ctx.deny('Reps sell in the north.', { row, field: 'region' }) : ctx.allow();
		} },
		delete: { check: function* (rows, ctx) {
			return rows.every((r) => r.created_by === ctx.actor.id) ? ctx.allow() : ctx.deny('Reps delete their own orders.');
		} }
	},
	lines: {
		update: { check: function* (changes, ctx) {
			const { orders } = yield* ctx.db.query({ orders: { where: { id: { in: changes.map((c) => c.before.order) } }, fields: ['region'] } });
			return orders.rows.every((o) => o.region === 'north') ? ctx.allow() : ctx.deny('Reps change lines of northern orders.');
		} }
	}
} } }
};`
};

export const ACME = '0199a000-0000-4000-8000-0000000000c1';
export const SHADY = '0199a000-0000-4000-8000-0000000000c2';
export const seed = {
	customers: [
		{ id: ACME, name: 'Acme', blocked: false },
		{ id: SHADY, name: 'Shady', blocked: true }
	]
};
