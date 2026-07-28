import { custom, dateRange, defineModel, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		component_type_id: uuid().notNull(),
		statutory_contribution_id: uuid().notNull(),
		authority: text().notNull(),
		treatment: custom('contribution_treatment').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'The grid: what one kind of pay is worth to one statutory contribution on a given date. Rows are generated as UNSET for every pair, so a cell is never absent — only undecided — and UNSET blocks activation.',
		recordLabel: ['component_type_id', 'statutory_contribution_id'],
		icon: 'lucide:grid-3x3',
		// Plan 02 §7: type =, contribution =, effective range &&. `norbital_daterange` rather than
		// an inline `(effective_range->>'start')::date` because `date_in` is STABLE and Postgres
		// refuses a non-IMMUTABLE function in a constraint expression.
		exclusions: [
			{
				name: 'contribution_treatments_no_overlap',
				elements: [
					{ expr: 'component_type_id', with: '=' },
					{ expr: 'statutory_contribution_id', with: '=' },
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
