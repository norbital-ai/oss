import { model } from '../../../../../../../src/index.ts';

export default model('orders', {
	description: 'Sales orders',
	record_label: 'record.number',
	fields: {
		number: { kind: 'seq', pattern: 'SO-{0000}' },
		amount: { kind: 'money' },
		customer: { kind: 'ref', to: 'customers', inverse: 'orders' },
		status: {
			kind: 'state',
			initial: 'draft',
			states: { draft: { to: ['placed'] }, placed: { edit: 'none' } }
		}
	},
	outputs: { default: { fields: 'all', customer: { fields: ['name', 'rating'] } } },
	create: { columns: { orders: ['customer', 'amount'] } }
});
