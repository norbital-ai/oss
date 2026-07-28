import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * What a matched contribution band awards.
 *
 * `PERCENT.employee` / `PERCENT.employer` and `PROGRESSIVE.rate` are PERCENTAGE NUMBERS, not
 * fractions: 11 means 11%. That is how a statute states a rate, so a rate can be read off a
 * gazette and typed in. The engine divides by 100 in exactly one place — `asFraction()` in
 * `collections/payroll_runs/lib/contribute.ts`.
 *
 * `PROGRESSIVE` is `constant + (base − band_from) × rate / 100`, where `constant` is the
 * CUMULATIVE tax at the band's lower bound; it is the ONLY value in the whole schema — besides
 * `leave_ledger.days` — that is allowed to be negative.
 */
export const rateAwardSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('PERCENT'),
		employee: z.number().check(z.minimum(0)),
		employer: z.number().check(z.minimum(0))
	}),
	z.strictObject({
		kind: z.literal('FIXED'),
		employee: z.number().check(z.minimum(0)),
		employer: z.number().check(z.minimum(0))
	}),
	z.strictObject({
		kind: z.literal('PROGRESSIVE'),
		rate: z.number().check(z.minimum(0)),
		constant: z.number()
	})
]);

export type RateAward = z.infer<typeof rateAwardSchema>;

export default defineCustomType({ name: 'rate_award', schema: rateAwardSchema });
