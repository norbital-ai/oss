import { boolean, defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		quote_id: uuid().notNull(),
		product_id: uuid().notNull(),
		product_code: text().notNull(),
		product_name: text().notNull(),
		product_unit: text(),
		quantity: numeric().notNull(),
		unit_price: numeric().notNull(),
		discount_pct: numeric(),
		tax_rate: numeric(),
		net: numeric(),
		tax: numeric(),
		line_total: numeric(),
		below_floor: boolean()
	},
	{
		description:
			'Line items on a quote. Snapshots product code, name, unit, and price at creation. Records whether the line sold below its cost-plus-markup floor, which is the fact an approval policy gates on — the floor itself is computed server-side and never stored here, because sales can read this table.',
		recordLabel: ['product_name', 'quantity'],
		icon: 'lucide:list-checks',
		indexes: [{ columns: ['quote_id'] }, { columns: ['product_id'] }, { columns: ['below_floor'] }]
	}
);
