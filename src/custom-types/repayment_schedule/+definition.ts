import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/** One loan has one schedule containing N independently editable repayment instalments. */
export const repaymentScheduleEntrySchema = z.strictObject({
	due_date: z.iso.date(),
	amount: z.number().check(z.positive())
});

export const repaymentScheduleSchema = z
	.array(repaymentScheduleEntrySchema)
	.check(z.minLength(1), z.maxLength(600));

export type RepaymentSchedule = z.infer<typeof repaymentScheduleSchema>;

export default defineCustomType({ name: 'repayment_schedule', schema: repaymentScheduleSchema });
