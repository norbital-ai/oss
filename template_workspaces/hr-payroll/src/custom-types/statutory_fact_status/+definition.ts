import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * Whether an employment is registered for a statutory contribution.
 * `rate_override` replaces a percentage award (e.g. voluntary EPF), or replaces a progressive
 * scheme with a flat award on current remuneration (e.g. non-resident PCB); `null` = use the band.
 */
export const statutoryFactStatusSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('REGISTERED'),
		reference_number: z.string().check(z.minLength(1)),
		rate_override: z.nullable(z.number().check(z.minimum(0)))
	}),
	z.strictObject({ kind: z.literal('NOT_REGISTERED'), reason: z.string().check(z.minLength(1)) })
]);

export type StatutoryFactStatus = z.infer<typeof statutoryFactStatusSchema>;

export default defineCustomType({
	name: 'statutory_fact_status',
	description:
		'Whether an employment is registered with a statutory scheme and under which reference number, with an optional rate that replaces the band’s own, or the stated reason it is not registered.',
	schema: statutoryFactStatusSchema
});
