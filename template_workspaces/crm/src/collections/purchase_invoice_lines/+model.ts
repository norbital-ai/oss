import { defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		purchase_invoice_id: uuid().notNull(),
		purchase_order_line_id: uuid().notNull(),
		product_code: text().notNull(),
		product_name: text({ search: true }).notNull(),
		quantity: numeric().notNull(),
		unit_cost: numeric().notNull(),
		tax_rate: numeric(),
		net: numeric(),
		tax: numeric(),
		line_total: numeric()
	},
	{
		description:
			'One invoiced quantity against one purchase order line. Snapshots the product and prices from the order line at creation; cumulative invoiced quantity per order line is capped at the ordered quantity across live invoices.',
		recordLabel: ['product_name', 'quantity'],
		icon: 'lucide:list-checks',
		indexes: [{ columns: ['purchase_invoice_id'] }, { columns: ['purchase_order_line_id'] }]
	}
);
