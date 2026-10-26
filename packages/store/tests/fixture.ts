// One schema exercising every relation kind, composite and natural keys, audit columns and inline values.
import { schema, table } from '../src/index.ts';

export const shop = schema({
	// a plain table on a natural text key, no audit columns
	tenant: table({ key: ['handle'], fields: { handle: { kind: 'text' }, name: { kind: 'text' } } }),
	// a composite key
	environment: table({
		key: ['tenant', 'name'],
		fields: {
			tenant: { kind: 'text' },
			name: { kind: 'text' },
			generation: { kind: 'int', default: 0 },
			deleted_at: { kind: 'instant', optional: true }
		}
	}),
	customer: table({
		audit: true,
		natural: ['code'],
		fields: {
			code: { kind: 'text' },
			name: { kind: 'text' },
			credit: { kind: 'decimal', scale: 2, default: 0 }
		}
	}),
	order: table({
		audit: true,
		fields: {
			number: { kind: 'text', unique: true },
			customer: { kind: 'ref', to: 'customer', inverse: 'orders' },
			status: { kind: 'enum', values: ['open', 'shipped'], default: 'open' },
			placed_on: { kind: 'date' },
			total: { kind: 'decimal', scale: 2 },
			address: {
				kind: 'object',
				optional: true,
				fields: {
					city: { kind: 'text' },
					zip: { kind: 'text', optional: true },
					floor: { kind: 'int', optional: true }
				}
			},
			labels: { kind: 'list', of: { kind: 'text' }, default: [] },
			events: {
				kind: 'list',
				default: [],
				of: { kind: 'object', fields: { at: { kind: 'instant' }, what: { kind: 'text' } } }
			}
		},
		through: { tags: { table: 'order_tag', from: 'order', to: 'tag' } },
		paths: [
			{ field: 'address', path: ['city'] },
			{ field: 'events', gin: true }
		]
	}),
	line: table({
		audit: true,
		fields: {
			order: { kind: 'ref', to: 'order', inverse: 'lines', owned: true },
			__store_row: { kind: 'int', optional: true },
			__store_row_: { kind: 'int', optional: true },
			sku: { kind: 'text' },
			qty: { kind: 'int' }
		}
	}),
	tag: table({ audit: true, fields: { label: { kind: 'text', unique: true } } }),
	order_tag: table({
		audit: true,
		fields: {
			order: { kind: 'ref', to: 'order' },
			tag: { kind: 'ref', to: 'tag' }
		}
	}),
	// a polymorphic ref, and its inverse on each target
	note: table({
		audit: true,
		fields: {
			body: { kind: 'text' },
			about: { kind: 'ref', to: ['customer', 'order'], inverse: 'notes', optional: true }
		}
	}),
	// a self relation
	employee: table({
		audit: true,
		fields: {
			name: { kind: 'text' },
			manager: { kind: 'ref', to: 'employee', inverse: 'reports', optional: true }
		}
	})
});
