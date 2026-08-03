import { boolean, defineModel, numeric, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		external_code: text().notNull(),
		code: text().notNull(),
		name: text().notNull(),
		description: text(),
		unit: text(),
		unit_price: numeric(),
		active: boolean().notNull()
	},
	{
		description:
			'Products and services in the catalogue. The table is the mirror of the external system of record: `external_code` is the system\u2019s item code, and the import pipeline keeps the table in step with it. Quote and purchase lines snapshot from here at creation, so a later catalogue edit never rewrites a historical document.',
		recordLabel: 'name',
		icon: 'lucide:package',
		indexes: [
			{ columns: ['external_code'], unique: true },
			{ columns: ['code'], unique: true }
		]
	}
);
