// A hand-written workspace for the type corpus: the literals a template would put in its +model.ts files.
import { customField, model } from '../../../src/index.ts';

export const customers = model({
	description: 'Buyers', label: 'name',
	fields: {
		name: { kind: 'text' },
		email: { kind: 'text', format: 'email', optional: true },
		tier: { kind: 'enum', values: ['basic', 'gold'], default: 'basic' },
		tags: { kind: 'text', many: true, optional: true },
		order_count: { kind: 'count', of: 'orders' },
	},
	search: { text: ['name'] },
});

export const orders = model({
	description: 'Sales orders', label: ['number', 'customer'],
	fields: {
		number: { kind: 'seq', pattern: 'SO-{0000}' },
		status: { kind: 'state', initial: 'draft', states: {
			draft: { to: ['submitted'] }, submitted: { to: ['ordered', 'draft'], edit: ['status', 'note', 'lines'] }, ordered: { edit: 'none' } } },
		note: { kind: 'text', optional: true },
		due: { kind: 'date', optional: true },
		placed_at: { kind: 'instant', optional: true },
		total: { kind: 'sum', of: 'lines.amount', where: { qty: { gt: 0 } } },
		line_count: { kind: 'count', of: 'lines' },
		colour: { kind: 'vector', dim: 3, metric: 'l2', optional: true },
	},
	index: ['customer', 'due'],
	computed: { due_soon: { kind: 'date', expr: { plusDays: [{ field: 'due' }, -7] } } },
	check: { has_customer: { customer: { isNull: false } } },
});

export const order_lines = model({
	description: 'Lines of an order', label: 'item',
	fields: { item: { kind: 'text' }, qty: { kind: 'decimal', scale: 3 }, price: { kind: 'money' } },
	computed: { amount: { kind: 'money', expr: { round: [{ times: [{ field: 'price' }, { field: 'qty' }] }, 2] } } },
});

export const notices = model({
	description: 'Supplier notices mirrored from the inbox', label: 'subject', key: ['message_id'],
	fields: { message_id: { kind: 'text' }, subject: { kind: 'text' }, received_at: { kind: 'instant' } },
	search: { text: ['subject'] },
});

export const notice_notes = model({
	description: 'What we add about a notice', label: 'notice',
	fields: { note: { kind: 'text' } },
	unique: [{ fields: ['notice'] }],
});

export const sites = model({
	description: 'Customer sites', label: 'name',
	fields: {
		name: { kind: 'text', max: 120 },
		zone: { kind: 'text', format: 'zone' },
		location: { kind: 'point', optional: true },
		open: { kind: 'period', of: 'date' },
		opens_at: { kind: 'time', optional: true },
		slot: { kind: 'duration', default: '30min' },
		photos: { kind: 'file', accept: ['image/*'], max: '5MiB', multiple: true, optional: true },
		checklist: { kind: 'json', shape: { kind: 'list', of: { kind: 'object', fields: { item: { kind: 'text' }, done: { kind: 'bool' } } } } },
		rating: { kind: 'custom', of: 'rating', optional: true },
		budget: { kind: 'money', currency: 'EUR', optional: true },
	},
	noOverlap: [{ key: ['name'], period: 'open' }],
});

export const rating = customField({
	description: 'A score with an optional note',
	shape: { kind: 'object', fields: { score: { kind: 'int', min: 1, max: 5 }, note: { kind: 'text', optional: true } } },
});
