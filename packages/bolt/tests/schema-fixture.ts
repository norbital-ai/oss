// A small workspace slice exercising every kind and constraint the DDL renders (shared by the schema tests), beside the
// built-in layer every slice carries (`schemaSlice`).
import { tables_of } from '../src/protocol/catalog.ts';
import type { SchemaSlice } from '../src/engine/schema/plan.ts';

export const slice = (): SchemaSlice => ({
	tz: 'Asia/Singapore',
	currency: 'SGD',
	tables: tables_of(
		{
			customers: {
				description: 'customers',
				record_label: 'record.name',
				fields: {
					name: { kind: 'text', max: 20 },
					email: { kind: 'text', format: 'email', optional: true },
					tags: { kind: 'enum', values: ['vip', 'new'], many: true, default: [] },
					open_orders: { kind: 'count', of: 'orders', where: { status: { eq: 'open' } } },
					spent: { kind: 'sum', of: 'orders.total' },
					place: { kind: 'point', optional: true },
					colour: { kind: 'vector', dim: 3, metric: 'l2', optional: true }
				},
				key: ['name'],
				unique: [{ fields: ['name'], name: 'one_name', import_key: true }, { fields: ['email'], name: 'email' }],
				search: { text: ['name', 'tags', 'shout'] },
				computed: { shout: { kind: 'text', expr: { upper: { field: 'name' } } } }
			},
			orders: {
				description: 'orders',
				record_label: 'record.code',
				fields: {
					code: { kind: 'seq', pattern: 'SO-{yyyy}-{0000}' },
					status: {
						kind: 'state',
						initial: 'open',
						states: { open: { to: ['closed'] }, closed: {} }
					},
					total: { kind: 'money' },
					jpy: { kind: 'money', currency: 'JPY', optional: true },
					qty: { kind: 'int', min: 0 },
					rate: { kind: 'decimal', scale: 2, precision: 5, optional: true },
					placed: { kind: 'date', default: { var: 'today' } },
					at: { kind: 'instant', default: { var: 'now' } },
					note: { kind: 'json', optional: true }
				},
				locks: { closed: { where: { status: { eq: 'closed' } } } },
				check: { closed_has_qty: { or: [{ status: { eq: 'open' } }, { qty: { gt: 0 } }] } },
				computed: {
					gross: { kind: 'money', expr: { round: [{ times: [{ field: 'total' }, 1.09] }, 2] } },
					due: { kind: 'date', expr: { plus_days: [{ field: 'placed' }, 30] } },
					label: {
						kind: 'text',
						expr: {
							concat: [
								{ field: 'code' },
								' / ',
								{ text: { field: 'placed' } },
								' / ',
								{ text: { field: 'qty' } }
							]
						}
					},
					month: { kind: 'date', expr: { start_of: [{ field: 'placed' }, 'month'] } },
					big: { kind: 'bool', expr: { when: [{ gt: [{ field: 'qty' }, 10] }, true, false] } },
					per: { kind: 'decimal', expr: { div: [{ field: 'total' }, { field: 'qty' }] } },
					slug: {
						kind: 'text',
						expr: { lower: { regex_replace: [{ trim: { field: 'code' } }, '[^A-Za-z0-9]+', '-'] } }
					},
					head: {
						kind: 'text',
						expr: { coalesce: [{ substring: [{ field: 'code' }, 1, 2] }, 'x'] }
					}
				}
			},
			terms: {
				description: 'terms',
				record_label: 'record.grade',
				fields: {
					grade: { kind: 'text', optional: true },
					period: { kind: 'period', of: 'date' },
					scope: { kind: 'text', optional: true }
				},
				no_overlap: [{ key: ['customer', 'scope'], period: 'period' }],
				unique: [
					{ fields: ['customer', 'grade'] },
					{ fields: ['grade'], where: { scope: { eq: 'x' } }, name: 'one_x_grade' }
				]
			},
			notes: {
				description: 'notes',
				record_label: 'record.body',
				fields: { body: { kind: 'text' } }
			}
		},
		{
			'orders.customer': { to: 'customers', inverse: 'orders', owned: true },
			'orders.owner': { to: 'sys_user', optional: true },
			'terms.customer': { to: 'customers', inverse: 'terms' },
			'notes.about': { to: ['customers', 'orders'], inverse: 'notes' }
		}
	)
});
