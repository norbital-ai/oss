/**
 * Eligibility.
 *
 * `pay_components.eligibility` and `leave_types.eligibility` are rule lists: **all** must match, and
 * an empty list means everyone. An ineligible component produces nothing at all — no line, no feed
 * into a base, no zero row. That is what keeps `ot_eligible ? … : 0` out of formulas, and it is why
 * a manager simply has no overtime line rather than an overtime line of zero.
 */

import type { WorkspaceRow } from '../$types.js';

export type EligibilityRules = NonNullable<WorkspaceRow<'pay_components'>['eligibility']>;

export type EligibilitySubject = {
	readonly employment_type: string | null;
	readonly work_classification: string | null;
	readonly service_months: number;
	readonly gender: string | null;
	readonly department: string | null;
	readonly payroll_group: string | null;
};

function includes(list: readonly string[], value: string | null): boolean {
	return value != null && list.includes(value);
}

/** Whether every rule matches. */
export function isEligible(rules: EligibilityRules | null, subject: EligibilitySubject): boolean {
	if (rules == null || rules.length === 0) return true;
	return rules.every((rule: EligibilityRules[number]) => {
		switch (rule.field) {
			case 'EMPLOYMENT_TYPE':
				return includes(rule.in, subject.employment_type);
			case 'WORK_CLASSIFICATION':
				return includes(rule.in, subject.work_classification);
			case 'SERVICE_MONTHS':
				return (
					subject.service_months >= rule.from &&
					(rule.to == null || subject.service_months < rule.to)
				);
			case 'GENDER':
				return includes(rule.in, subject.gender);
			case 'DEPARTMENT':
				return includes(rule.in, subject.department);
			case 'PAYROLL_GROUP':
				return includes(rule.in, subject.payroll_group);
		}
		return false;
	});
}
