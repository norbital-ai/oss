import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * Where a company holiday applies. `REGIONAL` always carries at least one location code —
 * this replaces a nullable `location_codes` column that would be meaningless for national
 * holidays.
 */
export const holidayScopeSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('NATIONAL') }),
	z.strictObject({
		kind: z.literal('REGIONAL'),
		location_codes: z.array(z.string().check(z.minLength(1))).check(z.minLength(1))
	})
]);

export type HolidayScope = z.infer<typeof holidayScopeSchema>;

export default defineCustomType({ name: 'holiday_scope', schema: holidayScopeSchema });
