import { defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		purchase_order_id: uuid().notNull(),
		product_id: uuid().notNull(),
		product_code: text().notNull(),
		product_name: text().notNull(),
		product_spec: text(),
		product_unit: text(),
		quantity: numeric().notNull(),
		unit_cost: numeric().notNull(),
		tax_rate: numeric(),
		net: numeric(),
		tax: numeric(),
		line_total: numeric()
	},
	{
		description:
			'Line items on a purchase order. Snapshots the product code, name, specification, and unit at creation so the line still reads correctly after the catalogue moves on.',
		recordLabel: ['product_name', 'quantity'],
		icon: 'lucide:list-checks',
		indexes: [{ columns: ['purchase_order_id'] }, { columns: ['product_id'] }]
	}
);
