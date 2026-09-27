import { collection } from '../../../src/index.ts';

export const customers = collection('customers', {
	read: { fields: 'all' },
	create: { input: { columns: ['name', 'email', 'tier'], filled: ['name'] } },
	update: { input: { columns: ['name', 'email', 'tier', 'tags'] } },
	queries: { gold: { description: 'Gold customers', input: { min: { kind: 'int', optional: true } },
		output: { kind: 'list', of: { kind: 'id', of: 'customers', where: { tier: { eq: 'gold' } } } } } },
});

export const orders = collection('orders', {
	read: { fields: 'all' },
	create: { input: { columns: ['customer', 'note', 'due'], with: { lines: { create: { columns: ['item', 'qty', 'price'] } } } } },
	update: { input: { columns: ['status', 'note', 'due', 'placed_at'],
		with: { lines: { create: { columns: ['item', 'qty', 'price'] }, update: { columns: ['qty'] }, delete: {} } } } },
	delete: { transform: true },
	queries: { open_total: { description: 'Sum of open orders', input: { since: { kind: 'date' } }, output: { kind: 'money' } } },
	actions: {
		submit: { description: 'Submit this order', target: 'record', input: {} },
		renote: { description: 'Set a note on many orders', input: { ids: { kind: 'list', of: { kind: 'id', of: 'orders' } }, note: { kind: 'text' } },
			output: { kind: 'int' } },
	},
	similarity: { by_colour: { description: 'Orders of a similar colour', input: { lab: { kind: 'vector', dim: 3, metric: 'l2' } }, candidates: 4 } },
	notifications: {
		approvalStepRequested: [{ channel: 'inbox', to: ['step_approvers', { user: 'owner' }, { team: 'Finance' }], title: 'Order to approve', body: '{label}' }],
	},
});

export const order_lines = collection('order_lines', { read: { fields: 'all' } });
export const notices = collection('notices', { read: { fields: 'all' }, queries: {
	recent: { description: 'Latest notices', input: {}, output: { kind: 'list', of: { kind: 'id', of: 'notices' } } } } });
export const notice_notes = collection('notice_notes', { read: { fields: 'all' }, create: { input: { columns: ['notice', 'note'] } } });
export const sites = collection('sites', { read: { fields: ['name', 'location', 'customer', 'open'], relations: [] },
	update: { input: { columns: ['name', 'location'] } } });
