import {
	boolean,
	custom,
	dateRange,
	defineModel,
	enums,
	numeric,
	sql,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		base_salary: custom('money').notNull(),
		pay_frequency: enums(['MONTHLY', 'SEMI_MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY']).notNull(),
		ordinary_hours_per_week: numeric().notNull(),
		working_days_per_week: numeric().notNull(),
		work_classification: enums(['EA_COVERED', 'NON_EA', 'MANAGERIAL']).notNull(),
		/**
		 * First Schedule work category used to decide whether the RM4,000 exclusion from statutory
		 * OT/rest-day/public-holiday pay applies. Seeded values are inferred and remain editable.
		 */
		statutory_work_category: enums([
			'NON_MANUAL',
			'MANUAL_LABOUR',
			'MANUAL_LABOUR_SUPERVISOR',
			'COMMERCIAL_VEHICLE_OPERATOR',
			'VESSEL_WORK'
		])
			.notNull()
			.default('NON_MANUAL'),
		employment_type: enums([
			'PERMANENT',
			'CONTRACT',
			'PROBATION',
			'INTERN',
			'CONSULTANT'
		]).notNull(),
		overtime_eligible: boolean().notNull(),
		department: text(),
		job_title: text(),
		payroll_group: text(),
		/**
		 * Which week shape governs these terms. When set it is authoritative: it names the rest and
		 * off days outright and says which weekday the week starts on.
		 *
		 * Optional only for continuity with terms written before patterns existed, which fall back to
		 * `rest_day` and `working_days_per_week` below. New terms should name a pattern — the
		 * fallback can only guess which non-rest days are off days, and guessing wrong prices a day
		 * at the ordinary rate that should have earned the rest-day multiple.
		 */
		work_pattern_id: uuid(),
		/** Superseded by `work_pattern_id`. Retained for terms that predate work patterns. */
		rest_day: enums(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']).notNull(),
		effective_range: dateRange().notNull(),
		/**
		 * The terms' own title, composed in SQL.
		 *
		 * `recordLabel` compiles to a CEL concatenation and CEL has no `+` overload for anything but
		 * strings; a null term throws outright in a multi-field label, and `job_title` is nullable.
		 * The title keeps both halves of the old label — the role when there is one, the employment
		 * type always — and lets the database, not CEL, decide what an absent job title composes to.
		 */
		summary: text({ search: true }).generatedAlwaysAs(
			sql`COALESCE(job_title || ' · ', '') || employment_type`
		)
	},
	{
		description:
			'The effective-dated terms of one employment — pay, hours, statutory work category, classification and the work pattern shaping its week. A change is an end-date plus a successor row, never an update in place.',
		recordLabel: 'summary',
		icon: 'lucide:file-signature',
		// Plan 02 §7: employment =, effective range &&. One employment has exactly one set of terms
		// on any date, so the engine's terms lookup returns at most one row structurally.
		exclusions: [
			{
				name: 'employment_terms_no_overlap',
				elements: [
					{ expr: 'employment_id', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
