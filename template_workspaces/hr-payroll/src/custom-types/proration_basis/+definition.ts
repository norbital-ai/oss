import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * How a jurisdiction prorates a monthly wage across a partial period.
 * `FIXED_DAYS` names the divisor explicitly (e.g. 26 working days).
 */
export const prorationBasisSchema = z.discriminatedUnion('by', [
	z.strictObject({ by: z.literal('CALENDAR_DAYS') }),
	z.strictObject({ by: z.literal('WORKING_DAYS') }),
	z.strictObject({ by: z.literal('FIXED_DAYS'), days: z.number().check(z.positive()) })
]);

export type ProrationBasis = z.infer<typeof prorationBasisSchema>;

export default defineCustomType({
	name: 'proration_basis',
	description:
		'The divisor a jurisdiction prorates a monthly wage by across a partial period: calendar days, working days, or a fixed number of days such as 26.',
	schema: prorationBasisSchema
});
