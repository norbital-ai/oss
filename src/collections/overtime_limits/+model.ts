import { dateRange, defineModel, enums, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		jurisdiction_id: uuid().notNull(),
		period: enums(['DAY', 'WEEK', 'MONTH']).notNull(),
		max_hours: numeric().notNull(),
		on_exceed: enums(['WARN', 'BLOCK']).notNull(),
		authority: text().notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'The statutory ceiling on overtime hours per day, week or month in a jurisdiction, and whether exceeding it warns or blocks.',
		recordLabel: ['period', 'max_hours'],
		icon: 'lucide:timer-off'
	}
);
