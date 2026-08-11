import { assertNoOverlap } from '../../lib/effective_range.js';
import type { Hooks } from './$types.js';

/**
 * Exclusion key (plan 02 §7): jurisdiction =, code =, effective range &&.
 *
 * The database is the guarantee — `statutory_contributions_no_overlap` in +model.ts rejects an
 * overlap with SQLSTATE 23P01 whatever path the write takes, including a concurrent one. This
 * hook is the message: it fails first and names the row and the clash instead of raising a raw
 * constraint violation.
 */
export default {
	create: {
		before: {
			description:
				'Refuses a statutory contribution scheme whose effective range overlaps another scheme with the same code in the same jurisdiction, so a deduction like EPF or SOCSO resolves to one scheme per date.',
			handler: async ({ input, api }) => {
				const existing = await api.db.query.statutory_contributions.findMany({
					where: { jurisdiction_id: { eq: input.jurisdiction_id }, code: { eq: input.code } }
				});
				assertNoOverlap({
					candidate: input.effective_range,
					existing,
					identity: `statutory contribution ${input.code} in this jurisdiction`
				});
				return input;
			}
		}
	},
	update: {
		before: {
			description:
				'Re-checks an edited contribution scheme so a change of law becomes an end-date plus a successor row rather than two versions of one scheme code in force together.',
			handler: async ({ input, existing, api }) => {
				const jurisdiction_id = input.jurisdiction_id ?? existing.jurisdiction_id;
				const code = input.code ?? existing.code;
				const effective_range = input.effective_range ?? existing.effective_range;
				const siblings = await api.db.query.statutory_contributions.findMany({
					where: { jurisdiction_id: { eq: jurisdiction_id }, code: { eq: code } }
				});
				assertNoOverlap({
					candidate: effective_range,
					existing: siblings,
					identity: `statutory contribution ${code} in this jurisdiction`,
					excludeId: existing.norbital_id
				});
				return input;
			}
		}
	}
} satisfies Hooks;
