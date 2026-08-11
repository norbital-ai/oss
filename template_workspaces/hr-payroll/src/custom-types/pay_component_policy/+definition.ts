import { dateRangeZodSchema, defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';
import { contributionTreatmentSchema } from '../contribution_treatment/+definition.js';

const statutoryTreatmentSchema = z.strictObject({
	statutory_contribution_id: z.uuid(),
	authority: z.string().check(z.minLength(1)),
	treatment: contributionTreatmentSchema,
	effective_range: dateRangeZodSchema
});
const treatments = z.array(statutoryTreatmentSchema);

/** Economic direction and statutory treatment are one closed policy union on the component. */
export const payComponentPolicySchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('INFORMATION'),
		settlement: z.literal('NONE'),
		statutory_treatments: treatments
	}),
	z.strictObject({
		kind: z.literal('EARNING'),
		settlement: z.literal('ADD'),
		statutory_treatments: treatments
	}),
	z.strictObject({
		kind: z.literal('ABSENCE'),
		settlement: z.literal('DEDUCT'),
		statutory_treatments: treatments
	}),
	z.strictObject({
		kind: z.literal('DEDUCTION'),
		settlement: z.literal('DEDUCT'),
		statutory_treatments: treatments
	}),
	z.strictObject({
		kind: z.literal('NON_WAGE_PAYMENT'),
		settlement: z.literal('ADD'),
		statutory_treatments: treatments
	}),
	z.strictObject({
		kind: z.literal('EMPLOYER_COST'),
		settlement: z.literal('EMPLOYER_ONLY'),
		statutory_treatments: treatments
	})
]);

export type PayComponentPolicy = z.infer<typeof payComponentPolicySchema>;
export default defineCustomType({
	name: 'pay_component_policy',
	description:
		'Whether a pay component adds to net pay, deducts from it, costs the employer alone or is information only, together with how each statutory contribution charges it over each effective range.',
	schema: payComponentPolicySchema
});
