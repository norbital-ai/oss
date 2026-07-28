import { refuse } from '@norbital-ai/pod/authoring';
import { assertNoOverlap } from '../../lib/effective_range.js';
import type { Hooks } from './$types.js';

/**
 * Terms are effective-dated: one employment has at most one set of terms in force at any instant.
 *
 * The database is the guarantee — `employment_terms_no_overlap` in +model.ts rejects an overlap
 * with SQLSTATE 23P01 whatever path the write takes, including a concurrent one. This hook is the
 * message: it fails first and names the row and the clash instead of raising a raw constraint
 * violation.
 */
function requireEmployment(value: string | null | undefined): string {
	if (value == null || value === '') {
		refuse('Employment terms must reference an employment.');
	}
	return value;
}

export default {
	create: {
		before: async ({ input, api }) => {
			const employmentId = requireEmployment(input.employment_id);
			const siblings = await api.db.query.employment_terms.findMany({
				where: { employment_id: { eq: employmentId } }
			});
			assertNoOverlap({
				candidate: input.effective_range,
				existing: siblings,
				identity: `employment ${employmentId}`
			});
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			const employmentId = requireEmployment(input.employment_id ?? existing.employment_id);
			const siblings = await api.db.query.employment_terms.findMany({
				where: { employment_id: { eq: employmentId } }
			});
			assertNoOverlap({
				candidate: input.effective_range ?? existing.effective_range,
				existing: siblings,
				identity: `employment ${employmentId}`,
				excludeId: existing.norbital_id
			});
			return input;
		}
	}
} satisfies Hooks;
