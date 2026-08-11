import { defineCustomType } from '@norbital-ai/pod/authoring';
import { z } from 'zod/mini';

/**
 * When an employment's money settles, where the plain pay calendar would put it somewhere else.
 *
 * `companies.pay_cutoff_day` says which days a run covers. It cannot say what happens at the two
 * ends of an employment — the period someone joins in and the period they leave in — nor what
 * happens when an absence outlives the window that would otherwise carry it. Those are the
 * customer's own rules about **settlement**, not the law's rules about pay, so they are COMPANY
 * level and they are data.
 *
 * All fields are optional deviations. A company that states none of them behaves exactly as
 * the pay calendar alone describes, which is what every company did before this type existed.
 *
 * A variant cannot be a foreign key: `defer_to_component_id` and `population_contribution_id` are
 * validated in `companies/+hooks.ts`, not by a constraint.
 */
export const settlementPolicySchema = z.strictObject({
	/**
	 * An employment that starts after the period's attendance window has already closed did no
	 * day of work the run can measure. Rather than pay a stub for days the run cannot see, the
	 * joining period is skipped and what it would have paid arrives in the next period as
	 * arrears on this component.
	 *
	 * `null` — pay the stub in the joining period.
	 */
	late_joiner_arrears: z.nullable(z.strictObject({ defer_to_component_id: z.uuid() })),
	/**
	 * An employment that ends between the attendance window's close and the end of the period
	 * has a tail of days that no later run will ever look at, because there is no later run.
	 * `SETTLE_IN_FINAL_PERIOD` extends the final run's attendance window to the exit date so
	 * that tail is measured; `FOLLOW_ATTENDANCE_WINDOW` leaves it unmeasured.
	 */
	final_period: z.enum(['SETTLE_IN_FINAL_PERIOD', 'FOLLOW_ATTENDANCE_WINDOW']),
	/**
	 * Whether recurring wages cover only the employment days in a final period or the full
	 * payroll period. One reference configuration keeps full monthly salary and allowances, then
	 * applies the period's attendance deductions separately; prorating first would deduct the leaver twice.
	 */
	final_period_wages: z.enum(['PRORATE_TO_EXIT', 'FULL_PERIOD']),
	/**
	 * Unpaid absence long enough to be a leave of absence rather than a missed day is deducted
	 * in the calendar month it falls in, not the month whose attendance window happens to carry
	 * it — so a leave starting on the 15th is felt in that month's pay, not the next one's.
	 *
	 * `null` — every unpaid day follows the attendance window.
	 */
	extended_unpaid_leave: z.nullable(
		z.strictObject({
			/** First day to last day inclusive, in calendar days. */
			minimum_calendar_days: z.int().check(z.positive()),
			/**
			 * A break shorter than this does not end the absence. Rest days, public holidays and
			 * a weekend inside a leave of absence are not a return to work, and counting them as
			 * one would split a single month-long leave into a dozen short ones.
			 */
			bridged_gap_days: z.int().check(z.nonnegative()),
			/**
			 * Restrict the rule to employments registered for this statutory scheme; `null`
			 * applies it to everyone. Naming a scheme is how a company selects a population
			 * without payroll having to learn what that population is: a scheme an employment
			 * is enrolled in is an effective-dated fact HR already maintains, and it is the
			 * customer, not the engine, that knows which scheme means what.
			 */
			population_contribution_id: z.nullable(z.uuid())
		})
	),
	/**
	 * A payroll cadence may value an unpaid day on a different divisor from the jurisdiction's
	 * default proration rule. One example company uses the NWPC 261-day factor (21.75 days/month),
	 * while semi-monthly staff use the working days in their period.
	 */
	absence_proration: z.nullable(
		z.array(
			z.strictObject({
				pay_frequency: z.enum(['MONTHLY', 'SEMI_MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY']),
				basis: z.discriminatedUnion('by', [
					z.strictObject({ by: z.literal('CALENDAR_DAYS') }),
					z.strictObject({ by: z.literal('WORKING_DAYS') }),
					z.strictObject({
						by: z.literal('FIXED_DAYS'),
						days: z.number().check(z.positive())
					})
				])
			})
		)
	),
	/**
	 * A cadence may use a narrower attendance slice for overtime and night shift while unpaid
	 * leave continues to follow the company's ordinary cutoff. One example semi-monthly payroll uses
	 * OT/NS from the 1st–15th while NPL remains on the 21st–20th window.
	 */
	overtime_windows: z.nullable(
		z.array(
			z.strictObject({
				pay_frequency: z.enum(['MONTHLY', 'SEMI_MONTHLY', 'WEEKLY', 'DAILY', 'HOURLY']),
				start_day: z.int().check(z.minimum(1), z.maximum(31)),
				end_day: z.int().check(z.minimum(1), z.maximum(31))
			})
		)
	)
});

export type SettlementPolicy = z.infer<typeof settlementPolicySchema>;

export default defineCustomType({
	name: 'settlement_policy',
	description:
		'A company’s deviations from its plain pay calendar: deferring a late joiner’s first pay to arrears, how a leaver’s final days are measured and paid, which divisor values an unpaid day, when a long absence counts as a leave of absence, and any narrower overtime window.',
	schema: settlementPolicySchema
});
