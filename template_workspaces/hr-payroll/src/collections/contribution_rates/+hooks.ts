import { assertNoOverlap, numericRangesOverlap } from '../../lib/effective_range.js';
import { variantField, variantNumber, variantTag } from '../../lib/variant.js';
import type { Hooks } from './$types.js';

/**
 * Exclusion key (plan 02 §7): contribution =, **selector range &&**, effective range &&.
 *
 * Two-dimensional: two bands of one contribution may share an effective range as long as their
 * selectors do not overlap, and may share a selector as long as their effective ranges do not.
 * Only the pair overlapping in BOTH dimensions is a duplicate.
 *
 * The database is the guarantee — `contribution_rates_no_overlap` in +model.ts projects the same
 * key out of the JSONB selector and rejects an overlap with SQLSTATE 23P01 whatever path the write
 * takes, including a concurrent one. This hook is the message: it fails first, names the band it
 * clashes with, and reads the variant in TypeScript rather than as a SQL projection.
 */
function selectorsOverlap(a: unknown, b: unknown): boolean {
	const by = variantTag(a, 'by');
	if (by == null || by !== variantTag(b, 'by')) return false;
	if (by === 'RISK_CLASS') return variantField(a, 'class') === variantField(b, 'class');

	const wagesOverlap = numericRangesOverlap(
		variantNumber(a, 'from') ?? 0,
		variantNumber(a, 'to'),
		variantNumber(b, 'from') ?? 0,
		variantNumber(b, 'to')
	);
	if (!wagesOverlap) return false;
	// One scale published twice per marital category — the two halves never collide.
	if (by === 'WAGE_AND_MARITAL') return variantField(a, 'marital') === variantField(b, 'marital');
	if (by !== 'WAGE_AND_AGE') return true;

	return numericRangesOverlap(
		variantNumber(a, 'age_from') ?? 0,
		variantNumber(a, 'age_to'),
		variantNumber(b, 'age_from') ?? 0,
		variantNumber(b, 'age_to')
	);
}

export default {
	create: {
		before: async ({ input, api }) => {
			const siblings = await api.db.query.contribution_rates.findMany({
				where: { statutory_contribution_id: { eq: input.statutory_contribution_id } }
			});
			assertNoOverlap({
				candidate: input.effective_range,
				existing: siblings.filter((row) => selectorsOverlap(input.selector, row.selector)),
				identity: 'this contribution band'
			});
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const statutory_contribution_id =
				input.statutory_contribution_id ?? existing.statutory_contribution_id;
			const selector = input.selector ?? existing.selector;
			const effective_range = input.effective_range ?? existing.effective_range;
			const siblings = await api.db.query.contribution_rates.findMany({
				where: { statutory_contribution_id: { eq: statutory_contribution_id } }
			});
			assertNoOverlap({
				candidate: effective_range,
				existing: siblings.filter((row) => selectorsOverlap(selector, row.selector)),
				identity: 'this contribution band',
				excludeId: existing.norbital_id
			});
			return input;
		}
	}
} satisfies Hooks;
