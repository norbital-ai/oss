import {
	boolean,
	custom,
	dateRange,
	defineModel,
	enums,
	numeric,
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
		rest_day: enums(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']).notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'The effective-dated terms of one employment — pay, hours, statutory work category, classification and rest day. A change is an end-date plus a successor row, never an update in place.',
		recordLabel: ['job_title', 'employment_type'],
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
