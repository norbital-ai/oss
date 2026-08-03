import { boolean, defineModel, enums, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		external_code: text().notNull(),
		name: text().notNull(),
		industry: text(),
		website: text(),
		phone: text(),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		address: text(),
		active: boolean().notNull()
	},
	{
		description:
			'Customer companies. The table is the mirror of the external system of record: `external_code` is the system\u2019s customer code, and the import pipeline keeps the table in step with it.',
		recordLabel: 'name',
		icon: 'lucide:building-2',
		indexes: [{ columns: ['external_code'], unique: true }]
	}
);
