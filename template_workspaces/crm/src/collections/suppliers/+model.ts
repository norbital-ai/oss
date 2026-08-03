import { boolean, defineModel, enums, integer, phone, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		code: text().notNull(),
		name: text().notNull(),
		search_alias: text(),
		category: text(),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		payment_terms_days: integer(),
		contact_name: text(),
		phone: phone(),
		email: text(),
		address: text(),
		active: boolean().notNull(),
		notes: text()
	},
	{
		description:
			'Vendors you buy from. A purchase order inherits its currency and payment terms from the supplier, and snapshots the code and name so a later supplier rename never rewrites history.',
		recordLabel: 'name',
		icon: 'lucide:truck',
		indexes: [{ columns: ['code'], unique: true }, { columns: ['name'] }, { columns: ['active'] }]
	}
);
