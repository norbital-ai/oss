// The write area's test workspace: orders with owned lines (roll-ups, `seq`, a state with an explicit lock), and tags
// that `set_null` when their order goes. Shared by the unit and PGlite suites of `engine/write`.
import type { EngineManifest } from '../src/engine/manifest.ts';
import type { Pred } from '@norbital-ai/store';
import type {
	Arm,
	Authority,
	ModelAuthority,
	DeleteArm,
	EngineActor,
	WriteArm
} from '../src/engine/contracts.ts';

export const NOW = '2026-09-25T10:00:00.000Z';
export const TODAY = '2026-09-25';
const lineCols = ['label', 'amount'];
export const manifest: EngineManifest = {
	needs: [],
	workspace: { tz: 'UTC', locale: 'en' },
	models: {
		orders: {
			description: 'An order',
			record_label: 'record.title',
			unique: [{ fields: ['title'] }],
			locks: { submitted: { where: { status: { eq: 'submitted' } }, except: ['note', 'status'] } },
			fields: {
				title: { kind: 'text' },
				number: { kind: 'seq', pattern: 'PO-{yyyy}-{0000}' },
				status: {
					kind: 'state',
					initial: 'draft',
					states: { draft: { to: ['submitted'] }, submitted: { to: ['draft'] } }
				},
				note: { kind: 'text', optional: true },
				total: { kind: 'sum', of: 'lines.amount' },
				big_lines: { kind: 'count', of: 'lines', where: { amount: { gte: 100 } } }
			}
		},
		lines: {
			description: 'A line',
			record_label: 'record.label',
			fields: { label: { kind: 'text' }, amount: { kind: 'decimal', scale: 2 } }
		},
		tags: { description: 'A tag', record_label: 'record.name', fields: { name: { kind: 'text' } } }
	},
	relationships: {
		'lines.order': { to: 'orders', inverse: 'lines', owned: true },
		'tags.order': { to: 'orders', inverse: 'tags', optional: true, on_delete: 'set_null' }
	},
	exposures: {
		orders: {
			outputs: {
				default: {
					orders: { fields: 'all' },
					'orders.lines': { fields: 'all' },
					'orders.tags': { fields: 'all' }
				}
			},
			create: { columns: { orders: ['title', 'note', 'status'], 'orders.lines': lineCols } },
			update: {
				columns: {
					orders: ['title', 'note', 'status'],
					'orders.lines': lineCols,
					'orders.tags': []
				}
			},
			delete: {}
		},
		lines: {
			outputs: { default: { lines: { fields: 'all' } } },
			create: { columns: { lines: ['label', 'amount', 'order'] } },
			update: { columns: { lines: lineCols } },
			delete: {}
		},
		tags: {
			outputs: { default: { tags: { fields: 'all' } } },
			create: { columns: { tags: ['name'] } }
		}
	},
	integrations: {},
	policies: {},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
	agent: { skills: {} },
	groups: {}
};

export const TRUE: Pred = { t: 'const', value: true };
export const member: EngineActor = {
	kind: 'member',
	id: '0199a000-0000-7000-8000-00000000000a',
	email: 'a@example.com',
	phone: null,
	external: false,
	teams: [],
	team_path: [],
	admin: false,
	party: null
};
/** A read (or history) arm of policy `p`. */
const arm = (where: Pred = TRUE): Arm => ({ policy: 'p', where });
/** A create or update arm of policy `p`: the columns it admits per write path, and whether `p` declares its `check`. */
export const write_arm = (columns: WriteArm['columns'], check = false, policy = 'p'): WriteArm => ({
	policy,
	columns,
	check
});
/** A delete arm of policy `p`. */
export const delete_arm = (check = false, policy = 'p'): DeleteArm => ({ policy, check });
/**
 * `model`'s access points under policy `p` (decision 3): its root read in full, and create, update and delete admitting
 * every column the model declares per write path, with no `check` (an arm without one allows).
 */
export const grants = (model: string, over: Partial<ModelAuthority> = {}): ModelAuthority => {
	const spec = manifest.exposures[model];
	return {
		read: { default: { [model]: [{ ...arm(), history: true }] } },
		create: spec?.create === undefined ? [] : [write_arm(spec.create.columns)],
		update: spec?.update === undefined ? [] : [write_arm(spec.update.columns)],
		delete: spec?.delete === undefined ? [] : [delete_arm()],
		moves: { status: 'all' },
		...over
	};
};
export const authority = (models: Authority['models'], admin = false): Authority => ({
	key: 'k',
	actor: admin ? { ...member, admin: true } : member,
	admin,
	policies: ['p'],
	models,
	automations: [],
	capabilities: { apps: [], syncs: [], tools: [], mcp: [] },
	limits: [],
	teamTree: [],
	scopes: {}
});
export const admin = authority({}, true);
export { arm };
