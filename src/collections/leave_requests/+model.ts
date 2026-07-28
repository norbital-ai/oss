import { boolean, date, defineModel, file, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		leave_type_id: uuid().notNull(),
		from_date: date().notNull(),
		to_date: date().notNull(),
		days: numeric().notNull(),
		half_day_start: boolean().notNull().default(false),
		half_day_end: boolean().notNull().default(false),
		reason: text(),
		certificate_file: file()
	},
	{
		description:
			'A person asking for time off. There is no state column — the request and its ledger rows are written together and locked by the same platform approval stamp.',
		recordLabel: ['from_date', 'to_date'],
		icon: 'lucide:calendar-off'
	}
);
