import { custom, dateRange, defineModel, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		statutory_contribution_id: uuid().notNull(),
		selector: custom('rate_selector').notNull(),
		award: custom('rate_award').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'One band of one statutory contribution: the selector that picks it (wage, wage and age, headcount or risk class) and the award it pays. A floor is the first band, a ceiling the terminal one.',
		recordLabel: ['selector', 'effective_range'],
		icon: 'lucide:percent',
		// Plan 02 §7 — two-dimensional: contribution =, selector band &&, effective range &&.
		// Successive bands coexist because their selectors do not overlap; only a pair overlapping
		// in BOTH the band and the effective range is a duplicate.
		//
		// The selector is a variant, so the band is projected out of the JSONB. `::numeric` is
		// IMMUTABLE (`numeric_in` is `provolatile = 'i'`), unlike `::date`, so it is legal here.
		//
		// The band is the pair of ranges the selector actually keys on, matching `selectorsOverlap`
		// in +hooks.ts. Discriminator and risk class are equality members because a WAGE row and a
		// RISK_CLASS row are never the same cell; without them, RISK_CLASS rows (which have no
		// numeric band at all, so project to the unbounded range) would collide with each other and
		// with everything else. The age range is its own dimension because EPF/SOCSO/EIS all carry
		// an `age_from 60` row over the SAME wage bands (plan 14 §examples) — verified: collapsing
		// age into the wage band alone rejects that pair with 23P01. The marital category is an
		// equality member for the same reason: Malaysia's MTD Category 1 and Category 2 are one
		// scale published twice, so both cover the very same wages on the very same dates.
		exclusions: [
			{
				name: 'contribution_rates_no_overlap',
				elements: [
					{ expr: 'statutory_contribution_id', with: '=' },
					{ expr: "(selector->>'by')", with: '=' },
					{ expr: "COALESCE(selector->>'class', '')", with: '=' },
					{ expr: "COALESCE(selector->>'marital', '')", with: '=' },
					{
						expr: "numrange((selector->>'from')::numeric, (selector->>'to')::numeric, '[)')",
						with: '&&'
					},
					{
						expr: "numrange((selector->>'age_from')::numeric, (selector->>'age_to')::numeric, '[)')",
						with: '&&'
					},
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
