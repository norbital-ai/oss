import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * The instalment plan of a repayment agreement. There is no state column anywhere —
 * "settled" is `SUM(instalments) >= principal`, derived at read time.
 */
export const repaymentScheduleSchema = z.strictObject({
	instalment_amount: z.number().check(z.positive()),
	count: z.int().check(z.positive()),
	first_period: z.string().check(z.regex(/^\d{4}-\d{2}$/))
});

export type RepaymentSchedule = z.infer<typeof repaymentScheduleSchema>;

export default defineCustomType({ name: 'repayment_schedule', schema: repaymentScheduleSchema });
