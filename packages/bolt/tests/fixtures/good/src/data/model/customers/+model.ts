import { bind_model } from '../../../../../../../src/declarations.ts';

export default bind_model('customers')({
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
