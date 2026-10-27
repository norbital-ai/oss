import { model } from '../../../../../../../src/index.ts';

export default model('customers', {
	description: 'Buyers',
	label: 'name',
	fields: {
		name: { kind: 'text' },
		rating: { kind: 'custom', of: 'rating', optional: true },
		order_count: { kind: 'count', of: 'orders' }
	},
	read: 'all',
	create: { columns: { customers: ['name', 'rating'] } }
});
