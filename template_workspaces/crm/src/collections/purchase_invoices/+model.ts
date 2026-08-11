import {
	boolean,
	date,
	defineModel,
	enums,
	numeric,
	text,
	timestamp,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		doc_no: text({ search: true }).notNull(),
		purchase_order_id: uuid().notNull(),
		supplier_id: uuid().notNull(),
		supplier_code: text().notNull(),
		supplier_name: text().notNull(),
		invoice_reference: text(),
		invoice_date: date(),
		status: enums(['draft', 'confirmed', 'cancelled']),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		tax_inclusive: boolean().notNull(),
		net: numeric(),
		tax: numeric(),
		gross: numeric(),
		owner_id: uuid().notNull(),
		confirmed_at: timestamp(),
		cancelled_at: timestamp(),
		cancel_reason: text()
	},
	{
		description:
			'Supplier invoice booked against a confirmed purchase order — the accounts-payable side of the buy. Carries the supplier\u2019s own invoice number as `invoice_reference` and snapshots the supplier like the order did. Confirming it is the three-way match checkpoint: its lines allocate ordered quantities, goods receipts prove what arrived, and the totals are what gets paid.',
		recordLabel: 'doc_no',
		icon: 'lucide:receipt',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['purchase_order_id'] },
			{ columns: ['supplier_id'] },
			{ columns: ['status'] }
		]
	}
);
