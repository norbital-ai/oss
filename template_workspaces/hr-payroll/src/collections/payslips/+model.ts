import { defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		payroll_run_id: uuid().notNull(),
		employment_id: uuid().notNull(),
		gross: numeric().notNull(),
		total_deductions: numeric().notNull(),
		net: numeric().notNull(),
		employer_cost: numeric().notNull(),
		currency: text().notNull()
	},
	{
		description:
			"One person's settlement for one run. The totals are the sum of its lines and contributions; year-to-date is a SUM over payslips, never a stored column.",
		recordLabel: ['currency', 'net'],
		icon: 'lucide:receipt',
		indexes: [{ columns: ['payroll_run_id', 'employment_id'], unique: true }]
	}
);
