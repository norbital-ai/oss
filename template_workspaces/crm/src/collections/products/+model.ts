import { boolean, defineModel, numeric, text, timestamp } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		code: text().notNull(),
		name: text().notNull(),
		description: text(),
		grade: text(),
		supplier: text(),
		unit: text(),
		unit_price: numeric(),
		price_updated_at: timestamp(),
		active: boolean().notNull()
	},
	{
		description:
			'Products and services in the catalogue. Quote and purchase lines snapshot from these at creation, so a later catalogue edit never rewrites a historical document. Grade classifies the item and description carries whatever technical detail the trade needs.',
		recordLabel: 'name',
		icon: 'lucide:package',
		indexes: [{ columns: ['code'], unique: true }, { columns: ['grade'] }]
	}
);
