import { refuse } from '@norbital-ai/pod/authoring';
import { assertNoOverlap } from '../../lib/effective_range.js';
import type { Hooks } from './$types.js';

/**
 * One employment has at most one standing with one statutory scheme at any instant.
 *
 * The database is the guarantee — `employment_statutory_facts_no_overlap` in +model.ts rejects an
 * overlap with SQLSTATE 23P01 whatever path the write takes, including a concurrent one. This hook
 * is the message: it fails first and names the row and the clash instead of raising a raw
 * constraint violation.
 */
function requireId(value: string | null | undefined, what: string): string {
	if (value == null || value === '') {
		refuse(`A statutory fact must reference ${what}.`);
	}
	return value;
}

export default {
	create: {
		before: async ({ input, api }) => {
			const employmentId = requireId(input.employment_id, 'an employment');
			const contributionId = requireId(input.statutory_contribution_id, 'a statutory contribution');
			const siblings = await api.db.query.employment_statutory_facts.findMany({
				where: {
					employment_id: { eq: employmentId },
					statutory_contribution_id: { eq: contributionId }
				}
			});
			assertNoOverlap({
				candidate: input.effective_range,
				existing: siblings,
				identity: `employment ${employmentId} × contribution ${contributionId}`
			});
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const employmentId = requireId(
				input.employment_id ?? existing.employment_id,
				'an employment'
			);
			const contributionId = requireId(
				input.statutory_contribution_id ?? existing.statutory_contribution_id,
				'a statutory contribution'
			);
			const siblings = await api.db.query.employment_statutory_facts.findMany({
				where: {
					employment_id: { eq: employmentId },
					statutory_contribution_id: { eq: contributionId }
				}
			});
			assertNoOverlap({
				candidate: input.effective_range ?? existing.effective_range,
				existing: siblings,
				identity: `employment ${employmentId} × contribution ${contributionId}`,
				excludeId: existing.norbital_id
			});
			return input;
		}
	}
} satisfies Hooks;
