import {
	boolean,
	date,
	defineModel,
	enums,
	integer,
	numeric,
	text,
	timestamp,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		doc_no: text().notNull(),
		account_id: uuid().notNull(),
		contact_id: uuid(),
		title: text().notNull(),
		status: enums(['draft', 'sent', 'won', 'confirmed', 'fulfilled', 'cancelled', 'lost']),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		tax_inclusive: boolean().notNull(),
		valid_until: date(),
		net: numeric(),
		tax: numeric(),
		gross: numeric(),
		owner_id: uuid().notNull(),
		confirmed_at: timestamp(),
		fulfilled_at: timestamp(),
		description: text(),
		project_id: uuid(),
		revision_of: uuid(),
		revision_number: numeric(),
		trade: enums(['domestic', 'export']),
		warehouse_id: uuid(),
		logistics_owner_id: uuid(),
		payment_terms_days: integer(),
		shipping_terms: text(),
		cancelled_at: timestamp(),
		cancel_reason: text(),
		replaces_id: uuid()
	},
	{
		description:
			'Sales document — the CRM pipeline. Moves draft→sent→won (quote), then confirmed→fulfilled (order). Sent documents can be reopened to draft for revision, incrementing the revision number. Once confirmed it carries the fulfilment facts too: which warehouse ships it, who handles logistics, and the agreed payment and shipping terms.',
		recordLabel: 'doc_no',
		icon: 'lucide:file-text',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['account_id'] },
			{ columns: ['owner_id'] },
			{ columns: ['status'] },
			{ columns: ['project_id'] },
			{ columns: ['revision_of'] },
			{ columns: ['warehouse_id'] },
			{ columns: ['replaces_id'] }
		]
	}
);
