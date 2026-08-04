import { custom, dateRange, defineModel, integer, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		code: text().notNull(),
		name: text().notNull(),
		variant: custom('work_pattern_variant').notNull(),
		/**
		 * The shift worked on an ordinary day of a STANDARD week. Required for STANDARD and refused
		 * for ROSTERED, where the shift is named per day by the roster instead.
		 */
		default_shift_definition_id: uuid(),
		/**
		 * The scheduling limits this pattern promises to respect, checked when a roster month is
		 * published. Statute sets the floor, not the value: EA 1955 s.59 requires one whole rest day
		 * in each week, so this can be raised to be more generous but never lowered below one.
		 */
		min_rest_days_per_week: integer().notNull().default(1),
		max_consecutive_work_days: integer(),
		max_daily_work_minutes: integer(),
		min_minutes_between_shifts: integer(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'How a week is shaped for the people on it — which days are working, rest and off, which weekday the week starts on, and the scheduling limits a published roster must respect. STANDARD derives its days; ROSTERED takes every day from a published roster.',
		recordLabel: 'name',
		icon: 'lucide:calendar-cog',
		// One code names one pattern per company on any date, so an employment's pattern lookup
		// returns at most one row structurally rather than by convention.
		exclusions: [
			{
				name: 'work_patterns_no_overlap',
				elements: [
					{ expr: 'company_id', with: '=' },
					{ expr: 'code', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
