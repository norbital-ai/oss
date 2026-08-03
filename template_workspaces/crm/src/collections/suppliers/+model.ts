import { boolean, defineModel, enums, integer, phone, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		external_code: text().notNull(),
		code: text().notNull(),
		name: text().notNull(),
		category: text(),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		payment_terms_days: integer(),
		phone: phone(),
		email: text(),
		address: text(),
		active: boolean().notNull()
	},
	{
		description:
			'Vendors the business buys from. The table is the mirror of the external system of record: `external_code` is the system\u2019s vendor code, and the import pipeline keeps the table in step with it. A purchase order inherits its currency and payment terms from the supplier, and snapshots the code and name so a later supplier rename never rewrites history.',
		recordLabel: 'name',
		icon: 'lucide:truck',
		indexes: [
			{ columns: ['external_code'], unique: true },
			{ columns: ['code'], unique: true },
			{ columns: ['name'] },
			{ columns: ['active'] }
		]
	}
);
