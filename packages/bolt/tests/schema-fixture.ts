// A small workspace slice exercising every kind and constraint the DDL renders (shared by the schema tests), beside the
// built-in layer every slice carries (`schemaSlice`).
import type { SchemaSlice } from '../src/engine/schema/ddl.ts';
import { SYSTEM } from '../src/system/index.ts';

export const slice = (): SchemaSlice => ({
	tz: 'Asia/Singapore',
	currency: 'SGD',
	models: {
		...SYSTEM.models,
		customers: {
			description: 'customers', label: 'name',
			fields: {
				name: { kind: 'text', max: 20 },
				email: { kind: 'text', format: 'email', optional: true, unique: true },
				tags: { kind: 'enum', values: ['vip', 'new'], many: true, default: [] },
				open_orders: { kind: 'count', of: 'orders', where: { status: { eq: 'open' } } },
				spent: { kind: 'sum', of: 'orders.total' },
				place: { kind: 'point', optional: true },
				colour: { kind: 'vector', dim: 3, metric: 'l2', optional: true },
			},
			key: ['name'],
			search: { text: ['name', 'tags', 'shout'] },
			computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } },
		},
		orders: {
			description: 'orders', label: 'code',
			fields: {
				code: { kind: 'seq', pattern: 'SO-{yyyy}-{0000}' },
				status: { kind: 'state', initial: 'open', states: { open: { to: ['closed'] }, closed: { edit: 'none' } } },
				total: { kind: 'money' },
				jpy: { kind: 'money', currency: 'JPY', optional: true },
				qty: { kind: 'int', min: 0 },
				rate: { kind: 'decimal', scale: 2, precision: 5, optional: true },
				placed: { kind: 'date', default: { today: '' } },
				at: { kind: 'instant', default: { now: '' } },
				note: { kind: 'json', optional: true },
			},
			check: { closed_has_qty: { or: [{ status: { eq: 'open' } }, { qty: { gt: 0 } }] } },
			computed: {
				gross: { kind: 'money', expr: { round: [{ times: [{ field: 'total' }, 1.09] }, 2] } },
				due: { kind: 'date', expr: { plusDays: [{ field: 'placed' }, 30] } },
				label: { kind: 'text', expr: { concat: [{ field: 'code' }, ' / ', { text: { field: 'placed' } }, ' / ', { text: { field: 'qty' } }] } },
				month: { kind: 'date', expr: { startOf: [{ field: 'placed' }, 'month'] } },
				big: { kind: 'bool', expr: { when: [{ gt: [{ field: 'qty' }, 10] }, true, false] } },
				per: { kind: 'decimal', expr: { div: [{ field: 'total' }, { field: 'qty' }] } },
				slug: { kind: 'text', expr: { lower: { regexReplace: [{ trim: { field: 'code' } }, '[^A-Za-z0-9]+', '-'] } } },
				head: { kind: 'text', expr: { coalesce: [{ substring: [{ field: 'code' }, 1, 2] }, 'x'] } },
			},
		},
		terms: {
			description: 'terms', label: 'grade',
			fields: {
				grade: { kind: 'text', optional: true },
				period: { kind: 'period', of: 'date' },
				scope: { kind: 'text', optional: true },
			},
			noOverlap: [{ key: ['customer', 'scope'], period: 'period' }],
			unique: [{ fields: ['customer', 'grade'] }, { fields: ['grade'], where: { scope: { eq: 'x' } }, name: 'one_x_grade' }],
		},
		notes: { description: 'notes', label: 'body', fields: { body: { kind: 'text' } } },
	},
	relationships: {
		...SYSTEM.relationships,
		'orders.customer': { to: 'customers', inverse: 'orders', owned: true },
		'orders.owner': { to: 'sys_user', optional: true },
		'terms.customer': { to: 'customers', inverse: 'terms' },
		'notes.about': { to: ['customers', 'orders'], inverse: 'notes' },
	},
});
