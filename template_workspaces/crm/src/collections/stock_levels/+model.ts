import { defineModel, numeric, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		product_id: uuid().notNull(),
		qty_on_hand: numeric(),
		unit_cost: numeric(),
		stock_unit: text(),
		qty_as_of: timestamp(),
		cost_as_of: timestamp()
	},
	{
		description:
			'Company-wide quantity and cost for one product. Quantity and cost carry separate as-of timestamps because they usually arrive from different places and go stale at different rates. Cost is commercially sensitive: grant read on this collection only to roles allowed to see it.',
		recordLabel: 'product_id',
		icon: 'lucide:layers',
		indexes: [{ columns: ['product_id'], unique: true }]
	}
);
