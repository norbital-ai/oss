import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * What an overtime band pays: a multiple of the hourly ordinary rate, or a multiple of
 * the ordinary day wage.
 */
export const overtimeAwardSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('HOURLY_MULTIPLE'),
		multiple: z.number().check(z.positive())
	}),
	z.strictObject({
		kind: z.literal('DAY_WAGE_MULTIPLE'),
		multiple: z.number().check(z.positive())
	})
]);

export type OvertimeAward = z.infer<typeof overtimeAwardSchema>;

export default defineCustomType({
	name: 'overtime_award',
	description:
		'What an overtime band pays: a multiple of the hourly ordinary rate, or a multiple of the ordinary day wage.',
	schema: overtimeAwardSchema
});
