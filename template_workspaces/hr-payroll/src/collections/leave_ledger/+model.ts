import { date, defineModel, enums, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		leave_type_id: uuid().notNull(),
		entry_date: date().notNull(),
		kind: enums(['TAKEN', 'ADJUSTMENT', 'ENCASHMENT']).notNull(),
		days: numeric().notNull(),
		source_id: uuid(),
		note: text()
	},
	{
		description:
			'Insert-only ledger of leave movements. days is the one signed quantity in the schema; accrual, carry-forward and expiry are derived at read time, never stored.',
		recordLabel: ['entry_date', 'kind', 'days'],
		icon: 'lucide:list-ordered',
		indexes: [{ columns: ['employment_id', 'leave_type_id', 'entry_date'] }]
	}
);
