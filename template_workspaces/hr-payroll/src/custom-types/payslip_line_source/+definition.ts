import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * What a payslip line consumed. One line may consume many sources — an overtime line is
 * computed from every time entry in the attendance window, an unpaid-leave deduction from
 * the leave requests that caused it — so provenance is a child collection, not a column on
 * the line.
 *
 * A variant cannot be a foreign key: `entry_id`, `time_entry_id` and `leave_request_id` are
 * checked in `+hooks.ts`, not by a constraint.
 */
export const payslipLineSourceSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('COMPONENT_ENTRY'), entry_id: z.uuid() }),
	z.strictObject({ kind: z.literal('TIME_ENTRY'), time_entry_id: z.uuid() }),
	z.strictObject({ kind: z.literal('LEAVE_REQUEST'), leave_request_id: z.uuid() })
]);

export type PayslipLineSource = z.infer<typeof payslipLineSourceSchema>;

export default defineCustomType({ name: 'payslip_line_source', schema: payslipLineSourceSchema });
