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
		supplier_id: uuid().notNull(),
		supplier_code: text().notNull(),
		supplier_name: text().notNull(),
		status: enums(['draft', 'submitted', 'confirmed', 'cancelled']),
		currency: enums(['CNY', 'USD', 'EUR', 'GBP', 'JPY', 'SGD', 'HKD']),
		tax_inclusive: boolean().notNull(),
		expected_date: date(),
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
			'Purchase document — the buying pipeline. Moves draft→submitted→confirmed, with cancelled as a terminal state before confirmation. A confirmed order is the state the system of record books; it is terminal, which is what makes its figures safe to hand across the boundary.',
		recordLabel: 'doc_no',
		icon: 'lucide:shopping-cart',
		indexes: [
			{ columns: ['doc_no'], unique: true },
			{ columns: ['supplier_id'] },
			{ columns: ['status'] },
			{ columns: ['owner_id'] },
			{ columns: ['expected_date'] }
		]
	}
);
