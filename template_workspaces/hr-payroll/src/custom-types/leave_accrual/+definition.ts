import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/** Carry-forward policy. Carry-forward and expiry are DERIVED at read time — never a job. */
export const leaveCarrySchema = z.strictObject({
	limit_days: z.number().check(z.minimum(0)),
	expiry_months: z.int().check(z.minimum(0))
});

export type LeaveCarry = z.infer<typeof leaveCarrySchema>;

/**
 * How entitlement for a leave type comes into existence.
 * - `MONTHLY`   — pro-rata each completed month of the leave year.
 * - `UPFRONT`   — the whole band granted at the start of the leave year.
 * - `PER_EVENT` — no balance at all (maternity, compassionate); granted per request.
 */
export const leaveAccrualSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('MONTHLY'), carry: z.nullable(leaveCarrySchema) }),
	z.strictObject({ kind: z.literal('UPFRONT'), carry: z.nullable(leaveCarrySchema) }),
	z.strictObject({ kind: z.literal('PER_EVENT') })
]);

export type LeaveAccrual = z.infer<typeof leaveAccrualSchema>;

export default defineCustomType({
	name: 'leave_accrual',
	description:
		'How entitlement for a leave type comes into being — pro-rata each completed month, granted whole at the start of the leave year, or granted per event with no balance — plus any carry-forward limit and its expiry.',
	schema: leaveAccrualSchema
});
