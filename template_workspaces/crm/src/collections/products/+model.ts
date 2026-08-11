import { boolean, defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		external_code: text().notNull(),
		code: text().notNull(),
		name: text({ search: true }).notNull(),
		description: text(),
		spec: text(),
		unit: text(),
		unit_price: numeric(),
		tax_rate: numeric(),
		qty_on_hand: numeric(),
		main_supplier_id: uuid(),
		active: boolean().notNull()
	},
	{
		description:
			'Products and services in the catalogue. The table is the mirror of the external system of record: `external_code` is the system\u2019s item code, and the import pipeline keeps the table in step with it. Quote and purchase lines snapshot code, name, unit, and tax rate from here at creation, so a later catalogue edit never rewrites a historical document. `qty_on_hand` is the indicative stock mirror; buy cost never lives here — it stays on purchase lines, which sales has no grant to read.',
		recordLabel: 'name',
		icon: 'lucide:package',
		indexes: [
			{ columns: ['external_code'], unique: true },
			{ columns: ['code'], unique: true }
		]
	}
);
