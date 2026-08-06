import { defineModel, numeric, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		goods_receipt_id: uuid().notNull(),
		purchase_order_line_id: uuid().notNull(),
		quantity_received: numeric().notNull()
	},
	{
		description:
			'One received quantity against one purchase order line. Partial deliveries arrive as further receipts; the hook caps the cumulative received quantity at the ordered quantity, so an over-delivery is a conversation, not a silent row.',
		recordLabel: 'quantity_received',
		icon: 'lucide:list-checks',
		indexes: [{ columns: ['goods_receipt_id'] }, { columns: ['purchase_order_line_id'] }]
	}
);
