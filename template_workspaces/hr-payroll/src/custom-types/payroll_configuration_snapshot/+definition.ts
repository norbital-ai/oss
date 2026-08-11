import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/** One immutable, run-level record of the configuration that produced every payslip in the run. */
export const payrollConfigurationSnapshotSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('CAPTURED'),
		configuration_hash: z.string().check(z.minLength(1)),
		configuration: z.record(z.string(), z.unknown())
	}),
	z.strictObject({
		kind: z.literal('LEGACY_HASH_ONLY'),
		configuration_hash: z.string().check(z.minLength(1)),
		reason: z.string().check(z.minLength(1))
	})
]);

export type PayrollConfigurationSnapshot = z.infer<typeof payrollConfigurationSnapshotSchema>;

export default defineCustomType({
	name: 'payroll_configuration_snapshot',
	description:
		'The frozen copy of the rates, rules and terms a payroll run was calculated under, so every payslip stays traceable to the configuration that produced it.',
	schema: payrollConfigurationSnapshotSchema
});
