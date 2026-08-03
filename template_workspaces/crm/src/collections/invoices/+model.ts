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
		doc_no: text().notNull(),
		quote_id: uuid().notNull(),
		account_id: uuid().notNull(),
		status: enums(['draft', 'issued', 'settled', 'cancelled']),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		tax_inclusive: boolean().notNull(),
		issue_date: date(),
		due_date: date(),
		net: numeric(),
		tax: numeric(),
		gross: numeric(),
		owner_id: uuid().notNull(),
		issued_at: timestamp(),
		settled_at: timestamp(),
		cancelled_at: timestamp(),
		cancel_reason: text(),
		notes: text()
	},
	{
		description:
			'Billing document raised against a confirmed sales document. An order may be billed in several invoices, so each invoice line allocates against a specific order line and the order tracks how much of itself is still unbilled.',
		recordLabel: 'doc_no',
		icon: 'lucide:receipt',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['quote_id'] },
			{ columns: ['account_id'] },
			{ columns: ['status'] },
			{ columns: ['owner_id'] }
		]
	}
);
