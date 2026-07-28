import { assertNoOverlap, numericRangesOverlap } from '../../lib/effective_range.js';
import { variantNumber, variantTag } from '../../lib/variant.js';
import type { Hooks } from './$types.js';

/**
 * Exclusion key (plan 02 §7): jurisdiction =, day_type =, **band range &&**, effective range &&.
 * Two-dimensional — successive bands of the same day type coexist because their bands do not
 * overlap, so only a pair overlapping in both band and effective range is a duplicate.
 *
 * The database is the guarantee — `overtime_rules_no_overlap` in +model.ts projects the same key
 * out of the JSONB band and rejects an overlap with SQLSTATE 23P01 whatever path the write takes,
 * including a concurrent one. This hook is the message: it fails first, names the day type it
 * clashes on, and reads the variant in TypeScript rather than as a SQL projection.
 */
function bandsOverlap(a: unknown, b: unknown): boolean {
	const measure = variantTag(a, 'measure');
	if (measure == null || measure !== variantTag(b, 'measure')) return false;
	const [fromKey, toKey] =
		measure === 'FROM_START_OF_DAY'
			? (['from_fraction', 'to_fraction'] as const)
			: (['from_hours', 'to_hours'] as const);
	return numericRangesOverlap(
		variantNumber(a, fromKey) ?? 0,
		variantNumber(a, toKey),
		variantNumber(b, fromKey) ?? 0,
		variantNumber(b, toKey)
	);
}

export default {
	create: {
		before: async ({ input, api }) => {
			const siblings = await api.db.query.overtime_rules.findMany({
				where: { jurisdiction_id: { eq: input.jurisdiction_id }, day_type: { eq: input.day_type } }
			});
			assertNoOverlap({
				candidate: input.effective_range,
				existing: siblings.filter((row) => bandsOverlap(input.band, row.band)),
				identity: `overtime band on a ${input.day_type} day`
			});
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const jurisdiction_id = input.jurisdiction_id ?? existing.jurisdiction_id;
			const day_type = input.day_type ?? existing.day_type;
			const band = input.band ?? existing.band;
			const effective_range = input.effective_range ?? existing.effective_range;
			const siblings = await api.db.query.overtime_rules.findMany({
				where: { jurisdiction_id: { eq: jurisdiction_id }, day_type: { eq: day_type } }
			});
			assertNoOverlap({
				candidate: effective_range,
				existing: siblings.filter((row) => bandsOverlap(band, row.band)),
				identity: `overtime band on a ${day_type} day`,
				excludeId: existing.norbital_id
			});
			return input;
		}
	}
} satisfies Hooks;
