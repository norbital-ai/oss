import { custom, dateRange, defineModel, enums, text, uuid } from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		jurisdiction_id: uuid().notNull(),
		day_type: enums(['ORDINARY', 'REST_DAY', 'PUBLIC_HOLIDAY']).notNull(),
		authority: text({ search: true }).notNull(),
		band: custom('overtime_band').notNull(),
		award: custom('overtime_award').notNull(),
		effective_range: dateRange().notNull()
	},
	{
		description:
			'What overtime is worth in a jurisdiction: one band of hours (or fractions of normal hours) on one kind of day, and the multiple it pays.',
		recordLabel: ['day_type', 'authority'],
		icon: 'lucide:clock-4',
		// Plan 02 §7 — two-dimensional: jurisdiction =, day_type =, band &&, effective range &&.
		//
		// `band` is a variant whose bound fields differ per `measure` (`from_hours`/`to_hours` vs
		// `from_fraction`/`to_fraction`), so COALESCE picks whichever arm is present. `measure` is
		// an equality member because the two measures are different scales that must not be
		// compared: a rest day legitimately carries BOTH a FROM_START_OF_DAY day-wage rule over
		// [0, 0.5) and a BEYOND_NORMAL hourly rule from 0 — numerically overlapping, semantically
		// disjoint. Mirrors `bandsOverlap` in +hooks.ts.
		exclusions: [
			{
				name: 'overtime_rules_no_overlap',
				elements: [
					{ expr: 'jurisdiction_id', with: '=' },
					{ expr: 'day_type', with: '=' },
					{ expr: "(band->>'measure')", with: '=' },
					{
						expr:
							"numrange(COALESCE((band->>'from_hours')::numeric, (band->>'from_fraction')::numeric), " +
							"COALESCE((band->>'to_hours')::numeric, (band->>'to_fraction')::numeric), '[)')",
						with: '&&'
					},
					{ expr: 'norbital_daterange(effective_range)', with: '&&' }
				]
			}
		]
	}
);
