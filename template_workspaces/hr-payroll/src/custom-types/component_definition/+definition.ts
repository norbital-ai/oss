import { dateRangeZodSchema, defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';
import { eligibilityRulesSchema } from '../eligibility_rules/+definition.js';

const capAwardSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('FIXED'), amount: z.number().check(z.minimum(0)) }),
	z.strictObject({ kind: z.literal('FORMULA'), expr: z.string().check(z.minLength(1)) })
]);
const capLayer = {
	eligibility: eligibilityRulesSchema,
	authority: z.string().check(z.minLength(1)),
	award: capAwardSchema,
	reimbursement_percentage: z.number().check(z.minimum(0), z.maximum(100)),
	effective_range: dateRangeZodSchema
} as const;
const capLayerSchema = z.discriminatedUnion('level', [
	z.strictObject({ level: z.literal('STATUTORY'), ...capLayer }),
	z.strictObject({ level: z.literal('ORGANISATION'), ...capLayer }),
	z.strictObject({ level: z.literal('EMPLOYEE'), employment_id: z.uuid(), ...capLayer })
]);

/** Layered cap applied to a claimable or allowance ENTRY component. */
export const componentCapSchema = z.strictObject({
	period: z.enum(['CALENDAR_YEAR', 'LEAVE_YEAR', 'MONTH', 'LIFETIME', 'PER_EVENT']),
	matrix: z.strictObject({
		merge: z.literal('MAX_WITH_STATUTORY_FLOOR'),
		layers: z.array(capLayerSchema).check(z.minLength(1))
	}),
	on_exceed: z.enum(['BLOCK', 'ALLOW'])
});

export type ComponentCap = z.infer<typeof componentCapSchema>;

/**
 * How a pay component produces its amount.
 *
 * - `ENTRY`     — a person or an import supplies the number (claims, allowances, ad-hoc pay).
 * - `FORMULA`   — a CEL expression over the payslip context.
 * - `OVERTIME`  — the engine derives it from time entries + the jurisdiction's overtime rules.
 * - `OVERTIME_EXCESS` — overtime corresponding to work beyond the daily total-work boundary or
 *   calendar-month ordinary-OT limit. The hours are reclassified rather than dropped: same money,
 *   a different pay component, and therefore a different contribution treatment.
 * - `SCHEDULE`  — the contracted amount from `employment_terms` (basic salary).
 *
 * There is deliberately NO statutory information here: chargeability is reachable only via
 * `pay_components.policy.statutory_treatments`.
 */
export const componentDefinitionSchema = z.discriminatedUnion('source', [
	z.strictObject({
		source: z.literal('ENTRY'),
		unit: z.enum(['MONEY', 'DAYS', 'HOURS']),
		evidence: z.enum(['NONE', 'OPTIONAL', 'REQUIRED']),
		cap: z.nullable(componentCapSchema),
		settlement: z.enum(['PAYROLL', 'COMPANY_DIRECT'])
	}),
	z.strictObject({
		source: z.literal('FORMULA'),
		unit: z.enum(['MONEY', 'DAYS', 'HOURS', 'RATE']),
		expr: z.string().check(z.minLength(1))
	}),
	z.strictObject({
		source: z.literal('OVERTIME'),
		rule: z.strictObject({
			day_type: z.enum(['ORDINARY', 'REST_DAY', 'PUBLIC_HOLIDAY']),
			measure: z.enum(['BEYOND_NORMAL', 'FROM_START_OF_DAY']),
			band_from: z.number().check(z.minimum(0))
		}),
		minimum: z.nullable(z.number().check(z.positive()))
	}),
	z.strictObject({
		source: z.literal('OVERTIME_EXCESS'),
		/** Overtime corresponding to work beyond this total-work-hours boundary is reclassified. */
		after_total_work_hours: z.number().check(z.positive()),
		/** The overtime rule whose overflow this component receives. */
		rule: z.strictObject({
			day_type: z.enum(['ORDINARY', 'REST_DAY', 'PUBLIC_HOLIDAY']),
			measure: z.enum(['BEYOND_NORMAL', 'FROM_START_OF_DAY']),
			band_from: z.number().check(z.minimum(0))
		}),
		/**
		 * The statutory award's valuation basis. Hourly awards carry multiplier-weighted hours;
		 * stepped rest-day and holiday awards carry the additional day-wage multiple earned
		 * beyond the total-work-hours boundary.
		 */
		valued_at: z.enum(['ORDINARY_HOURLY', 'ORDINARY_DAY_WAGE'])
	}),
	z.strictObject({
		source: z.literal('SCHEDULE'),
		unit: z.literal('MONEY'),
		reducible: z.boolean()
	})
]);

export type ComponentDefinition = z.infer<typeof componentDefinitionSchema>;

export default defineCustomType({
	name: 'component_definition',
	description:
		'How a pay component gets its number — typed in as an entry under a layered claim cap, computed from a formula, derived from overtime rules, reclassified as overtime beyond the daily boundary, or taken from the contracted salary.',
	schema: componentDefinitionSchema
});
