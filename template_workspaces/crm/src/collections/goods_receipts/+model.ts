import { date, defineModel, text, timestamp, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		doc_no: text({ search: true }).notNull(),
		purchase_order_id: uuid().notNull(),
		received_date: date(),
		note: text(),
		owner_id: uuid().notNull(),
		received_at: timestamp()
	},
	{
		description:
			'Goods received against a confirmed purchase order. A receipt is an event, not a lifecycle document: it is written once, carries only what arrived, and the remaining-to-receive on the order is derived by subtracting received quantities from the ordered ones. Receiving never edits the order itself.',
		recordLabel: 'doc_no',
		icon: 'lucide:package-check',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['purchase_order_id'] },
			{ columns: ['owner_id'] }
		]
	}
);
