import {
	custom,
	dateRange,
	defineModel,
	enums,
	integer,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		jurisdiction_id: uuid().notNull(),
		name: text().notNull(),
		registration_number: text().notNull(),
		pay_cutoff_day: integer().notNull(),
		pay_day: integer().notNull(),
		leave_year_start_month: integer().notNull(),
		overtime_calculation_method: enums(['STATUTORY_AGGREGATE', 'INFOTECH_ANNUALISED_DATED'])
			.notNull()
			.default('STATUTORY_AGGREGATE'),
		/**
		 * What the pay calendar cannot say: how the period someone joins in, the period they leave
		 * in, and a leave of absence longer than one window settle. Company policy, not law — so it
		 * is here and not on `jurisdictions`. `null` means the plain calendar governs everything.
		 */
		settlement_policy: custom('settlement_policy'),
		risk_class: text(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'An employing entity inside one jurisdiction, with its pay calendar, overtime calculation, settlement policy, leave year and risk class. Headcount is derived from active employments, never stored.',
		recordLabel: 'name',
		icon: 'lucide:building-2'
	}
);
