import { boolean, defineModel, enums, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		name: text().notNull(),
		industry: text(),
		website: text(),
		phone: text(),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		address: text(),
		active: boolean().notNull()
	},
	{
		description: 'Companies and organizations you sell to. Formerly mirrored from ERP masters.',
		recordLabel: 'name',
		icon: 'lucide:building-2'
	}
);
