import { defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		sales_invoice_id: uuid().notNull(),
		quote_line_id: uuid().notNull(),
		product_code: text().notNull(),
		product_name: text({ search: true }).notNull(),
		product_unit: text(),
		quantity: numeric().notNull(),
		unit_price: numeric().notNull(),
		tax_rate: numeric(),
		net: numeric(),
		tax: numeric(),
		line_total: numeric()
	},
	{
		description:
			'One billed quantity against one quote line. Snapshots the product and price from the quote line at creation; cumulative allocated quantity per quote line is capped at the quoted quantity across live invoices.',
		recordLabel: ['product_name', 'quantity'],
		icon: 'lucide:list-checks',
		indexes: [{ columns: ['sales_invoice_id'] }, { columns: ['quote_line_id'] }]
	}
);
