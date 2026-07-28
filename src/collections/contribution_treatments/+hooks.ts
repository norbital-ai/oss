import { refuse } from '@norbital-ai/pod/authoring';
import { assertNoOverlap } from '../../lib/effective_range.js';
import { variantTag } from '../../lib/variant.js';
import type { Hooks } from './$types.js';

/**
 * The grid is generated, never authored sparse (plan 02 §7, 03 §6):
 *
 * - a cell is never deleted — removing one would turn "undecided" back into "absent", and an
 *   absent cell is the one failure the materialised grid exists to make impossible;
 * - a cell may only move AWAY from `UNSET` — a decision, once made, is superseded by another
 *   decision, not withdrawn;
 * - exclusion key: type =, contribution =, effective range &&.
 *
 * The database is the guarantee — `contribution_treatments_no_overlap` in +model.ts rejects an
 * overlap with SQLSTATE 23P01 whatever path the write takes, including a concurrent one. This hook
 * is the message: it fails first and names the row and the clash instead of raising a raw
 * constraint violation.
 */
export default {
	create: {
		before: async ({ input, api }) => {
			const siblings = await api.db.query.contribution_treatments.findMany({
				where: {
					component_type_id: { eq: input.component_type_id },
					statutory_contribution_id: { eq: input.statutory_contribution_id }
				}
			});
			assertNoOverlap({
				candidate: input.effective_range,
				existing: siblings,
				identity: 'this component type × statutory contribution cell'
			});
			return input;
		}
	},
	update: {
		before: async ({ input, existing, api }) => {
			if (input.treatment !== undefined && variantTag(input.treatment, 'kind') === 'UNSET') {
				refuse(
					'A treatment cannot be set back to UNSET. UNSET is the absence of a decision, not a way to treat pay — supersede it with INCLUDE, EXCLUDE, REDUCE or SPECIAL.'
				);
			}

			const component_type_id = input.component_type_id ?? existing.component_type_id;
			const statutory_contribution_id =
				input.statutory_contribution_id ?? existing.statutory_contribution_id;
			const effective_range = input.effective_range ?? existing.effective_range;
			const siblings = await api.db.query.contribution_treatments.findMany({
				where: {
					component_type_id: { eq: component_type_id },
					statutory_contribution_id: { eq: statutory_contribution_id }
				}
			});
			assertNoOverlap({
				candidate: effective_range,
				existing: siblings,
				identity: 'this component type × statutory contribution cell',
				excludeId: existing.norbital_id
			});
			return input;
		}
	},
	delete: {
		before: async () => {
			refuse(
				'Treatment rows are generated for every component type × statutory contribution pair and are never deleted. End-date the row and insert a successor instead.'
			);
		}
	}
} satisfies Hooks;
