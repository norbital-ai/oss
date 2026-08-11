import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * How an accrual band is looked up: by completed months of service (the band applies from
 * `band_from` months upward, until a higher band takes over) or flat for everyone.
 */
export const accrualKeySchema = z.discriminatedUnion('by', [
	z.strictObject({ by: z.literal('SERVICE_MONTHS'), band_from: z.int().check(z.minimum(0)) }),
	z.strictObject({ by: z.literal('FLAT') })
]);

export type AccrualKey = z.infer<typeof accrualKeySchema>;

export default defineCustomType({
	name: 'accrual_key',
	description:
		'How a leave accrual band is selected: from a number of completed months of service upward, or flat for every employee regardless of service.',
	schema: accrualKeySchema
});
