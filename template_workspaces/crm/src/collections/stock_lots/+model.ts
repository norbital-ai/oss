import { boolean, defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		product_id: uuid().notNull(),
		warehouse_id: uuid().notNull(),
		lot_no: text().notNull(),
		quantity: numeric().notNull(),
		unit: text(),
		sellable: boolean().notNull()
	},
	{
		description:
			'Quantity of one product in one lot at one warehouse. This collection deliberately holds no cost or price column: it is the breakdown sellers are shown, and a value here would hand cost to every role that can drill into availability.',
		recordLabel: ['lot_no', 'quantity'],
		icon: 'lucide:boxes',
		indexes: [
			{ columns: ['product_id', 'warehouse_id', 'lot_no'], unique: true },
			{ columns: ['product_id'] },
			{ columns: ['warehouse_id'] },
			{ columns: ['sellable'] }
		]
	}
);
