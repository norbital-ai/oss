import { model } from '../../../../../../../src/index.ts';

export default model('orders', {
	description: 'Sales orders',
	label: 'number',
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
	read: 'all',
	create: { columns: ['customer', 'amount'] },
	queries: {
		count_placed: {
			description: 'Placed orders',
			input: {},
			output: { kind: 'int' },
			run: function* () {
				return 0;
			}
		}
	}
});
