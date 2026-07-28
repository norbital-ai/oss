import { custom, dateRange, defineModel, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		employment_id: uuid().notNull(),
		statutory_contribution_id: uuid().notNull(),
		status: custom('statutory_fact_status').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'Where one employment stands with one statutory scheme — registered with a reference number, or not registered with a reason. An absent row means registered with nothing captured.',
		recordLabel: 'statutory_contribution_id',
		icon: 'lucide:badge-check',
		// Plan 02 §7: employment =, contribution =, effective range &&.
		exclusions: [
			{
				name: 'employment_statutory_facts_no_overlap',
				elements: [
					{ expr: 'employment_id', with: '=' },
					{ expr: 'statutory_contribution_id', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
