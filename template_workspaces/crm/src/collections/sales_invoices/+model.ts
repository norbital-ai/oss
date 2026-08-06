import {
	boolean,
	defineModel,
	enums,
	numeric,
	text,
	timestamp,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		doc_no: text().notNull(),
		quote_id: uuid().notNull(),
		account_id: uuid().notNull(),
		status: enums(['draft', 'issued', 'cancelled']),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		tax_inclusive: boolean().notNull(),
		net: numeric(),
		tax: numeric(),
		gross: numeric(),
		owner_id: uuid().notNull(),
		issued_at: timestamp(),
		cancelled_at: timestamp(),
		cancel_reason: text()
	},
	{
		description:
			'Billing document raised against a confirmed quote — the sales side of accounts receivable. One quote may bill over several invoices as allocated quantities allow; an issued invoice is terminal, which is what makes its figures safe to hand across the boundary.',
		recordLabel: 'doc_no',
		icon: 'lucide:file-text',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['quote_id'] },
			{ columns: ['account_id'] },
			{ columns: ['status'] }
		]
	}
);
