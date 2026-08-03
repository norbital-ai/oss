import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * How one pay component is charged against one statutory contribution.
 * `UNSET` is the generated default — every (component_type, contribution) pair exists
 * as a row, so chargeability is never inferred from a missing row.
 * `SPECIAL.rule` must name a rule listed on `statutory_contributions.special_rules`.
 */
export const contributionTreatmentSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('INCLUDE') }),
	z.strictObject({ kind: z.literal('EXCLUDE') }),
	z.strictObject({ kind: z.literal('REDUCE') }),
	z.strictObject({ kind: z.literal('SPECIAL'), rule: z.string().check(z.minLength(1)) }),
	z.strictObject({ kind: z.literal('UNSET') })
]);

export type ContributionTreatment = z.infer<typeof contributionTreatmentSchema>;

export default defineCustomType({
	name: 'contribution_treatment',
	schema: contributionTreatmentSchema
});
