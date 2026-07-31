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
		reference: text().notNull(),
		principal: numeric().notNull(),
		disbursed_on: date().notNull(),
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
