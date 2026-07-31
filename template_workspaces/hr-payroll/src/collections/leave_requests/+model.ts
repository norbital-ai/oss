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
			'A person asking for time off. Once approved, this record itself is the TAKEN leave movement; payroll links deductions directly to it.',
		recordLabel: ['from_date', 'to_date'],
		icon: 'lucide:calendar-off'
	}
);
