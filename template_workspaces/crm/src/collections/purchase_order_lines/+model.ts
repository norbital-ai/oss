import { defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		purchase_order_id: uuid().notNull(),
		product_id: uuid().notNull(),
		product_code: text().notNull(),
		product_name: text({ search: true }).notNull(),
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
			'Line items on a purchase order. Snapshots the product code, name, and unit at creation and computes amounts in the order\u2019s own tax mode and currency. The unit cost is a buy-side fact entered by the purchaser — it is never derived from the sales catalogue, and the cost column carries it only here, where sales has no grant.',
		recordLabel: ['product_name', 'quantity'],
		icon: 'lucide:list-checks',
		indexes: [{ columns: ['purchase_order_id'] }, { columns: ['product_id'] }]
	}
);
