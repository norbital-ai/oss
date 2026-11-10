import { model } from '../../../../../../../src/index.ts';

export default model('customers', {
	description: 'Buyers',
	record_label: 'record.name',
	fields: {
		name: { kind: 'text' },
		rating: { kind: 'custom', of: 'rating', optional: true },
		order_count: { kind: 'count', of: 'orders' }
	},
	outputs: { default: { fields: 'all' } },
	create: { columns: { customers: ['name', 'rating'] } }
});
