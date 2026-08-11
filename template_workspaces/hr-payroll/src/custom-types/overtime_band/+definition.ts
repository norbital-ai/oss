import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * The slice of a working day an overtime rule covers.
 * `BEYOND_NORMAL` counts hours past the normal daily hours;
 * `FROM_START_OF_DAY` counts fractions of a normal day worked from the first minute
 * (rest-day / public-holiday day-wage rules).
 * `to_*` is an exclusive upper bound; `null` means "open ended".
 */
export const overtimeBandSchema = z.discriminatedUnion('measure', [
	z.strictObject({
		measure: z.literal('BEYOND_NORMAL'),
		from_hours: z.number().check(z.minimum(0)),
		to_hours: z.nullable(z.number().check(z.minimum(0)))
	}),
	z.strictObject({
		measure: z.literal('FROM_START_OF_DAY'),
		from_fraction: z.number().check(z.minimum(0)),
		to_fraction: z.nullable(z.number().check(z.minimum(0)))
	})
]);

export type OvertimeBand = z.infer<typeof overtimeBandSchema>;

export default defineCustomType({
	name: 'overtime_band',
	description:
		'The slice of a working day an overtime rule covers, counted either as hours beyond the normal daily hours or as fractions of a normal day worked from the first minute.',
	schema: overtimeBandSchema
});
