import { defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		invoice_id: uuid().notNull(),
		quote_line_id: uuid().notNull(),
		product_id: uuid().notNull(),
		product_code: text().notNull(),
		product_name: text().notNull(),
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
			'Line items on an invoice. Each one bills a quantity against a specific sales document line, which is what makes partial billing and remaining-to-bill answerable.',
		recordLabel: ['product_name', 'quantity'],
		icon: 'lucide:list-checks',
		indexes: [
			{ columns: ['invoice_id'] },
			{ columns: ['quote_line_id'] },
			{ columns: ['product_id'] }
		]
	}
);
