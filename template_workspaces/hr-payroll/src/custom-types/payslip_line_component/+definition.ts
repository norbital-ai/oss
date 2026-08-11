import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

const payComponentId = { pay_component_id: z.uuid() } as const;
const entryIds = { ...payComponentId, component_entry_id: z.uuid() } as const;
const statutory = {
	statutory_contribution_id: z.uuid(),
	base_amount: z.number(),
	band_reference: z.nullable(z.string()),
	special_amounts: z.record(z.string(), z.number())
} as const;

/**
 * The exact thing one persisted payslip line represents. This closed union makes the line itself the
 * only junction: ordinary calculated components link to `pay_components`, entered components also
 * link to `component_entries`, and statutory lines link to their governing scheme.
 */
export const payslipLineComponentSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('SCHEDULE'), ...payComponentId }),
	z.strictObject({ kind: z.literal('FORMULA'), ...payComponentId }),
	z.strictObject({ kind: z.literal('OVERTIME'), ...payComponentId }),
	z.strictObject({ kind: z.literal('OVERTIME_EXCESS'), ...payComponentId }),
	z.strictObject({ kind: z.literal('DERIVED'), ...payComponentId }),
	/** Historical aggregated entry lines that cannot be split without inventing an allocation. */
	z.strictObject({ kind: z.literal('LEGACY_COMPONENT'), ...payComponentId }),
	z.strictObject({ kind: z.literal('COMPONENT_ENTRY_ONCE'), ...entryIds }),
	z.strictObject({ kind: z.literal('COMPONENT_ENTRY_RECURRING'), ...entryIds }),
	z.strictObject({ kind: z.literal('STATUTORY_EMPLOYEE'), ...statutory }),
	z.strictObject({ kind: z.literal('STATUTORY_EMPLOYER'), ...statutory })
]);

export type PayslipLineComponent = z.infer<typeof payslipLineComponentSchema>;

export default defineCustomType({
	name: 'payslip_line_component',
	description:
		'What one payslip line stands for — contracted salary, a formula, overtime or excess overtime, a derived or entered component, or an employee or employer statutory contribution — and the pay component, component entry or scheme it is linked to.',
	schema: payslipLineComponentSchema
});
