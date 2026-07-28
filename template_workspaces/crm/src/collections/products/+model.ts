import { boolean, defineModel, numeric, text, timestamp } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		code: text().notNull(),
		name: text().notNull(),
		description: text(),
		grade: text(),
		mfi: text(),
		density: text(),
		supplier: text(),
		unit: text(),
		unit_price: numeric(),
		price_updated_at: timestamp(),
		active: boolean().notNull()
	},
	{
		description:
			'Products and services in the catalogue. Quote lines snapshot from these at creation. Includes resin-grade technical specs.',
		recordLabel: 'name',
		icon: 'lucide:package',
		indexes: [{ columns: ['code'], unique: true }, { columns: ['grade'] }]
	}
);
