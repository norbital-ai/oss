import { boolean, date, defineModel, enums, numeric, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		account_id: uuid().notNull(),
		product_id: uuid().notNull(),
		unit_price: numeric().notNull(),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		valid_from: date(),
		valid_until: date(),
		active: boolean().notNull()
	},
	{
		description:
			'Customer-specific price overrides the product catalogue. Checked during quote line creation before falling back to the catalogue price.',
		recordLabel: ['account_id', 'product_id'],
		icon: 'lucide:tags',
		indexes: [
			{ columns: ['account_id', 'product_id'] },
			{ columns: ['account_id'] },
			{ columns: ['product_id'] }
		]
	}
);
