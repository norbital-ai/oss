import { dateRange, defineModel, enums, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		jurisdiction_id: uuid().notNull(),
		period: enums(['DAY', 'WEEK', 'MONTH']).notNull(),
		/**
		 * What `max_hours` counts.
		 *
		 * These are different quantities and the difference is not cosmetic: Malaysia's 104-a-month
		 * ceiling counts overtime hours, while its twelve-a-day ceiling counts *all* hours worked. A
		 * single unlabelled `max_hours` cannot carry both — read the wrong way, a 12 meant as total
		 * hours becomes a licence for twelve hours of overtime on top of a full shift.
		 *
		 * The Core decomposition report records the same distinction for Singapore, where writing the
		 * s.38(1)(b) twelve-hour total cap as an overtime number would only have been right for an
		 * eight-hour normal day.
		 */
		measures: enums(['OVERTIME_HOURS', 'TOTAL_WORK_HOURS']).notNull(),
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
