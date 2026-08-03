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
		supplier_id: uuid().notNull(),
		supplier_code: text().notNull(),
		supplier_name: text().notNull(),
		status: enums(['draft', 'submitted', 'confirmed', 'received', 'cancelled']),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		tax_inclusive: boolean().notNull(),
		expected_date: date(),
		warehouse_id: uuid(),
		payment_terms_days: integer(),
		net: numeric(),
		tax: numeric(),
		gross: numeric(),
		owner_id: uuid().notNull(),
		submitted_at: timestamp(),
		confirmed_at: timestamp(),
		received_at: timestamp(),
		cancelled_at: timestamp(),
		cancel_reason: text(),
		notes: text()
	},
	{
		description:
			'Purchase document — the buying pipeline. Moves draft→submitted→confirmed→received, and can be cancelled before it is received. A cancelled order keeps its number so the sequence stays gapless.',
		recordLabel: 'doc_no',
		icon: 'lucide:shopping-cart',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['supplier_id'] },
			{ columns: ['status'] },
			{ columns: ['owner_id'] },
			{ columns: ['warehouse_id'] },
			{ columns: ['expected_date'] }
		]
	}
);
