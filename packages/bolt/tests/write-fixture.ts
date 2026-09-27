// The write area's test workspace: orders with owned lines (roll-ups, `seq`, a state with a locking `edit`), and tags
// that `setNull` when their order goes. Shared by the unit and PGlite suites of `engine/write`.
import type { Authority, CollectionAuthority, EngineActor, EngineManifest, Pred } from '../src/engine/contracts.ts';

export const NOW = '2026-09-25T10:00:00.000Z';
export const TODAY = '2026-09-25';
const lineCols = { columns: ['label', 'amount'] };
export const manifest: EngineManifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: 'An order', label: 'title', unique: [{ fields: ['title'] }],
			fields: {
				title: { kind: 'text' },
				number: { kind: 'seq', pattern: 'PO-{yyyy}-{0000}' },
				status: { kind: 'state', initial: 'draft', states: { draft: { to: ['submitted'] }, submitted: { to: ['draft'], edit: ['note'] } } },
				note: { kind: 'text', optional: true },
				total: { kind: 'sum', of: 'lines.amount' },
				big_lines: { kind: 'count', of: 'lines', where: { amount: { gte: 100 } } },
			},
		},
		lines: { description: 'A line', label: 'label', fields: { label: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } } },
		tags: { description: 'A tag', label: 'name', fields: { name: { kind: 'text' } } },
	},
	relationships: {
		'lines.order': { to: 'orders', inverse: 'lines', owned: true },
		'tags.order': { to: 'orders', inverse: 'tags', optional: true, onDelete: 'setNull' },
	},
	collections: {
		orders: {
			read: { fields: 'all' },
			create: { input: { columns: ['title', 'note', 'status'], with: { lines: { create: lineCols } } } },
			update: { input: { columns: ['title', 'note', 'status'], with: { lines: { create: lineCols, update: lineCols, delete: {} }, tags: { link: {}, unlink: {} } } } },
			delete: {},
		},
		lines: { read: { fields: 'all' }, create: { input: { columns: ['label', 'amount', 'order'] } }, update: { input: lineCols }, delete: {} },
		tags: { read: { fields: 'all' }, create: { input: { columns: ['name'] } } },
	},
	integrations: {}, pipelines: {}, policies: {}, teams: {}, automations: {}, channels: {}, connections: {}, envoys: {}, mcp: {}, apps: {},
	customFields: {}, agent: { skills: {} },
};

export const TRUE: Pred = { t: 'const', value: true };
export const member: EngineActor = { kind: 'member', id: '0199a000-0000-7000-8000-00000000000a', email: 'a@example.com', external: false,
	teams: [], teamPath: [], admin: false, party: null };
const arm = (where: Pred = TRUE, fields: readonly string[] | 'all' = 'all') => ({ policy: 'p', where, fields, approval: [] as never[] });
export const grants = (over: Partial<CollectionAuthority> = {}): CollectionAuthority => ({
	read: [arm()], history: [], create: [arm()], update: [arm()], delete: [arm()], queries: [], actions: [], moves: { status: 'all' }, masks: {}, ...over,
});
export const authority = (collections: Authority['collections'], admin = false): Authority => ({
	key: 'k', actor: admin ? { ...member, admin: true } : member, admin, policies: ['p'], collections, automations: [],
	capabilities: { apps: [], tools: [], mcp: [], skills: [] }, limits: [], teamTree: [], scopes: {},
});
export const admin = authority({}, true);
export { arm };
