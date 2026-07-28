import { custom, date, defineModel, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		date: date().notNull(),
		/** Original holiday date when this row is an explicitly scheduled substitute holiday. */
		substitutes_date: date(),
		name: text().notNull(),
		scope: custom('holiday_scope').notNull()
	},
	{
		description:
			'A public holiday observed by a company, including an explicit substitute date where one is declared. Drives the PUBLIC_HOLIDAY day type used by the overtime rules.',
		recordLabel: ['date', 'name'],
		icon: 'lucide:calendar-x'
	}
);
