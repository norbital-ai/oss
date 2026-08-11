import { defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		quote_id: uuid().notNull(),
		product_id: uuid().notNull(),
		product_code: text().notNull(),
		product_name: text({ search: true }).notNull(),
		product_unit: text(),
		quantity: numeric().notNull(),
		unit_price: numeric().notNull(),
		discount_pct: numeric(),
		tax_rate: numeric(),
		net: numeric(),
		tax: numeric(),
		line_total: numeric()
	},
	{
		description:
			'Line items on a quote. Snapshots product code, name, unit, and price at creation, and computes net, tax, and total from the parent document\u2019s tax mode.',
		recordLabel: ['product_name', 'quantity'],
		icon: 'lucide:list-checks',
		indexes: [{ columns: ['quote_id'] }, { columns: ['product_id'] }]
	}
);
