import { dateRange, defineModel, enums, integer, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		jurisdiction_id: uuid().notNull(),
		code: text({ search: true }).notNull(),
		name: text({ search: true }).notNull(),
		authority: text().notNull(),
		payer: enums(['EMPLOYEE', 'EMPLOYER', 'BOTH']).notNull(),
		keyed_by: enums([
			'WAGE',
			'WAGE_AND_AGE',
			'WAGE_AND_MARITAL',
			'HEADCOUNT',
			'RISK_CLASS'
		]).notNull(),
		rounding: enums(['NONE', 'NEAREST_CENT', 'UP_TO_UNIT', 'TABLE']).notNull(),
		relief_for: uuid().array().notNull(),
		sequence: integer().notNull(),
		special_rules: text().array().notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'One statutory scheme in one jurisdiction — EPF, SOCSO, EIS, PCB, HRDF and their equivalents — with who pays, what keys its bands, how it rounds and which named special rules it implements.',
		recordLabel: ['code', 'name'],
		icon: 'lucide:landmark',
		// Plan 02 §7: jurisdiction =, code =, effective range &&.
		exclusions: [
			{
				name: 'statutory_contributions_no_overlap',
				elements: [
					{ expr: 'jurisdiction_id', with: '=' },
					{ expr: 'code', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
