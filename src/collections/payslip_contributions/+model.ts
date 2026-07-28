import { custom, defineModel, numeric, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		payslip_id: uuid().notNull(),
		statutory_contribution_id: uuid().notNull(),
		base_amount: numeric().notNull(),
		employee_amount: numeric().notNull(),
		employer_amount: numeric().notNull(),
		band_reference: text(),
		special_amounts: custom('special_amounts').notNull()
	},
	{
		description:
			'What one statutory scheme charged on one payslip — the base it was computed on, both shares, and the band that produced them. Year-to-date is a SUM over these rows.',
		recordLabel: ['band_reference', 'employee_amount'],
		icon: 'lucide:landmark',
		indexes: [{ columns: ['payslip_id'] }]
	}
);
