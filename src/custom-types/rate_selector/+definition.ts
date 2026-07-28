import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * Which band of a statutory contribution table a rate row applies to.
 * The discriminator mirrors `statutory_contributions.keyed_by`.
 * `to` bounds are exclusive upper limits; `null` means "open ended".
 */
export const rateSelectorSchema = z.discriminatedUnion('by', [
	z.strictObject({
		by: z.literal('WAGE'),
		from: z.number().check(z.minimum(0)),
		to: z.nullable(z.number().check(z.minimum(0)))
	}),
	z.strictObject({
		by: z.literal('WAGE_AND_AGE'),
		from: z.number().check(z.minimum(0)),
		to: z.nullable(z.number().check(z.minimum(0))),
		age_from: z.int().check(z.minimum(0)),
		age_to: z.nullable(z.int().check(z.minimum(0)))
	}),
	/**
	 * A wage ladder that a jurisdiction publishes twice, once per marital category — Malaysia's
	 * MTD Category 1 and Category 2 are the same scale with a larger s.6D rebate folded into
	 * Category 2's constants. It is the marital sibling of `WAGE_AND_AGE`: the category filters
	 * first, then the wage ceiling picks a row from what survives.
	 *
	 * `marital` names the CATEGORY, not the employee's civil status. `MARRIED` is the category for
	 * a taxpayer who carries a spouse — one who exists and has no total income of their own — and
	 * `SINGLE` is the category for everyone else, including a married taxpayer whose spouse earns.
	 * It is chosen from `employees.spouse_status`, which is the question the statute asks.
	 */
	z.strictObject({
		by: z.literal('WAGE_AND_MARITAL'),
		from: z.number().check(z.minimum(0)),
		to: z.nullable(z.number().check(z.minimum(0))),
		marital: z.enum(['SINGLE', 'MARRIED'])
	}),
	z.strictObject({
		by: z.literal('HEADCOUNT'),
		from: z.int().check(z.minimum(0)),
		to: z.nullable(z.int().check(z.minimum(0)))
	}),
	z.strictObject({ by: z.literal('RISK_CLASS'), class: z.string().check(z.minLength(1)) })
]);

export type RateSelector = z.infer<typeof rateSelectorSchema>;

export default defineCustomType({ name: 'rate_selector', schema: rateSelectorSchema });
