import { date, defineModel, enums, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		regarding_type: enums(['quotes', 'purchase_orders', 'purchase_invoices']),
		regarding_id: uuid().notNull(),
		amount: numeric().notNull(),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		settled_on: date(),
		reference: text(),
		owner_id: uuid().notNull()
	},
	{
		description:
			'A payment or settlement received (from a customer) or made (to a supplier) against a committed document. The paid / partial / unpaid status of a document is never stored: it is derived at render from the sum of its settlements against its gross, and only for committed documents — anything else shows an em-dash.',
		recordLabel: 'reference',
		icon: 'lucide:banknote',
		indexes: [{ columns: ['regarding_id'] }, { columns: ['regarding_type'] }]
	}
);
