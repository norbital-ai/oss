import {
	boolean,
	custom,
	dateRange,
	defineModel,
	integer,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		company_id: uuid().notNull(),
		code: text().notNull(),
		name: text().notNull(),
		eligibility: custom('eligibility_rules').notNull(),
		aggregates_with: text(),
		encash_on_exit: boolean().notNull(),
		requires_certificate_after_days: integer(),
		accrual: custom('leave_accrual').notNull(),
		payroll_effect: custom('leave_payroll_effect').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			"A company's kind of leave: who may take it, how it accrues and carries, whether it is encashed on exit, and what it does to pay. It carries no statutory flag of any kind.",
		recordLabel: ['code', 'name'],
		icon: 'lucide:calendar-days',
		// Plan 02 §7: company =, code =, effective range &&.
		exclusions: [
			{
				name: 'leave_types_no_overlap',
				elements: [
					{ expr: 'company_id', with: '=' },
					{ expr: 'code', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
