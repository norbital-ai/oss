import {
	custom,
	date,
	dateRange,
	defineModel,
	numeric,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		pay_component_id: uuid().notNull(),
		reference: text({ search: true }).notNull(),
		principal: numeric().notNull(),
		// Nullable because a loan is frequently evidenced by its recovery, not its payment. Employer
		// loan trackers state the amount lent and the instalment schedule — both required above — and
		// routinely omit the date the money left. Requiring it here did not make that date exist; it
		// made the agreement unrepresentable, so the instalments were seeded as payroll deductions
		// against no agreement at all. An unknown disbursement date is a smaller lie than a missing
		// loan, and the only alternative is inventing one.
		disbursed_on: date(),
		repay_by: date().notNull(),
		schedule: custom('repayment_schedule').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'A staff loan, salary advance or overpayment recovery. Its explicit schedule is the source of N payroll instalment entries; a paid-payslip linkage locks the consumed entry.',
		recordLabel: 'reference',
		icon: 'lucide:handshake'
	}
);
