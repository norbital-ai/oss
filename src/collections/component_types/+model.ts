import { defineModel, enums, integer, text } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		code: text().notNull(),
		name: text().notNull(),
		nature: enums([
			'INFORMATION',
			'EARNING',
			'ABSENCE',
			'DEDUCTION',
			'NON_WAGE_PAYMENT',
			'EMPLOYER_COST'
		]).notNull(),
		sequence: integer().notNull(),
		description: text()
	},
	{
		description:
			'The global, closed list of kinds of pay. Every pay component points at one, and chargeability is stated once per type in contribution_treatments rather than per component.',
		recordLabel: 'name',
		icon: 'lucide:tags',
		indexes: [{ columns: ['code'], unique: true }]
	}
);
