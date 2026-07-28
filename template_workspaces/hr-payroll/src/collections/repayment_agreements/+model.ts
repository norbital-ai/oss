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
		schedule: custom('repayment_schedule').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'A staff loan, salary advance or overpayment recovery — one agreement to deduct a principal over time. There is no state and no outstanding column: settled is SUM(instalments) >= principal.',
		recordLabel: 'reference',
		icon: 'lucide:handshake'
	}
);
