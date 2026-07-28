import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * What taking this leave does to pay. `UNPAID` names the deduction pay component that
 * carries the lost wage. A variant cannot be a foreign key — `component_id` is validated
 * in `+hooks.ts`, not by a constraint.
 */
export const leavePayrollEffectSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('PAID') }),
	z.strictObject({ kind: z.literal('UNPAID'), component_id: z.uuid() })
]);

export type LeavePayrollEffect = z.infer<typeof leavePayrollEffectSchema>;

export default defineCustomType({
	name: 'leave_payroll_effect',
	schema: leavePayrollEffectSchema
});
