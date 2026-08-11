import { dateRangeZodSchema, defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * Why a component entry exists. This replaces every "source" side table — one entry
 * stream, one origin variant.
 *
 * A variant cannot be a foreign key: `evidence_file`, `agreement_id`,
 * `reverses_entry_id` are validated in `+hooks.ts`, not by a constraint.
 */
export const entryOriginSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('RECURRING'),
		cadence: z.literal('PAY_PERIOD'),
		effective_range: dateRangeZodSchema
	}),
	z.strictObject({ kind: z.literal('ONE_OFF'), note: z.string() }),
	z.strictObject({
		kind: z.literal('CLAIM'),
		evidence_file: z.nullable(z.uuid()),
		incurred_on: z.iso.date()
	}),
	z.strictObject({
		kind: z.literal('LOAN_INSTALMENT'),
		agreement_id: z.uuid(),
		sequence: z.int().check(z.positive()),
		of: z.int().check(z.positive())
	}),
	z.strictObject({
		kind: z.literal('REVERSAL'),
		reverses_entry_id: z.uuid(),
		reason: z.string().check(z.minLength(1))
	}),
	z.strictObject({
		kind: z.literal('ARREARS'),
		covers_periods: z.array(z.string().check(z.regex(/^\d{4}-\d{2}$/))).check(z.minLength(1)),
		reason: z.string().check(z.minLength(1))
	})
]);

export type EntryOrigin = z.infer<typeof entryOriginSchema>;

export default defineCustomType({
	name: 'entry_origin',
	description:
		'Why a component entry exists — a recurring allowance, a one-off, a claim with its evidence and incurred date, a numbered loan instalment, a reversal of an earlier entry, or arrears covering named past periods.',
	schema: entryOriginSchema
});
