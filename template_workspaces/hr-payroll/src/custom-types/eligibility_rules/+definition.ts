import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * One eligibility predicate. `SERVICE_MONTHS.to` is an exclusive upper bound;
 * `null` means "no upper bound".
 */
export const eligibilityRuleSchema = z.discriminatedUnion('field', [
	z.strictObject({
		field: z.literal('EMPLOYMENT_TYPE'),
		in: z
			.array(z.enum(['PERMANENT', 'CONTRACT', 'PROBATION', 'INTERN', 'CONSULTANT']))
			.check(z.minLength(1))
	}),
	z.strictObject({
		field: z.literal('WORK_CLASSIFICATION'),
		in: z.array(z.enum(['EA_COVERED', 'NON_EA', 'MANAGERIAL'])).check(z.minLength(1))
	}),
	z.strictObject({
		field: z.literal('SERVICE_MONTHS'),
		from: z.int().check(z.minimum(0)),
		to: z.nullable(z.int().check(z.minimum(0)))
	}),
	z.strictObject({
		field: z.literal('GENDER'),
		in: z.array(z.enum(['MALE', 'FEMALE'])).check(z.minLength(1))
	}),
	z.strictObject({
		field: z.literal('DEPARTMENT'),
		in: z.array(z.string().check(z.minLength(1))).check(z.minLength(1))
	}),
	z.strictObject({
		field: z.literal('PAYROLL_GROUP'),
		in: z.array(z.string().check(z.minLength(1))).check(z.minLength(1))
	})
]);

export type EligibilityRule = z.infer<typeof eligibilityRuleSchema>;

/** ALL rules must match. An empty list means everyone is eligible. */
export const eligibilityRulesSchema = z.array(eligibilityRuleSchema);

export type EligibilityRules = z.infer<typeof eligibilityRulesSchema>;

export default defineCustomType({ name: 'eligibility_rules', schema: eligibilityRulesSchema });
