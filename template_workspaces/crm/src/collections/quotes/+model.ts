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
		account_id: uuid().notNull(),
		contact_id: uuid(),
		title: text().notNull(),
		status: enums(['draft', 'sent', 'won', 'confirmed', 'lost', 'cancelled']),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		tax_inclusive: boolean().notNull(),
		valid_until: date(),
		payment_terms: text(),
		shipping_terms: text(),
		place_of_loading: text(),
		place_of_delivery: text(),
		packaging: text(),
		shipping_mark: text(),
		time_of_shipment: text(),
		other_terms: text(),
		net: numeric(),
		tax: numeric(),
		gross: numeric(),
		owner_id: uuid().notNull(),
		description: text(),
		revision_of: uuid(),
		revision_number: numeric(),
		confirmed_at: timestamp(),
		credit_acknowledged: boolean(),
		cancelled_at: timestamp(),
		cancel_reason: text()
	},
	{
		description:
			'Sales document — the CRM pipeline. Moves draft→sent→won, then confirmed once accepted and pushed out to the third-party ERP. Lost and cancelled are terminal. Sent documents can be reopened to draft for revision, incrementing the revision number.',
		recordLabel: 'doc_no',
		icon: 'lucide:file-text',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['account_id'] },
			{ columns: ['owner_id'] },
			{ columns: ['status'] },
			{ columns: ['revision_of'] }
		]
	}
);
