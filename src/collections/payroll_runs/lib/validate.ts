/**
 * Step 2 — VALIDATE.
 *
 * Everything that can be wrong before a single employee is read. A run that would silently
 * under-contribute, silently not pay for work done, or silently read a missing decision as "not
 * chargeable" is blocked here, with a message that names the row to fix.
 *
 * Issues are structured rather than free text, so the run can report them and a screen can link to
 * them. A `BLOCKER` stops the build; a `WARNING` is recorded and the build continues.
 */

import type { Configuration } from './configuration.js';
import type { DailyOvertime } from './overtime.js';
import { parseSpecialRules } from './special-rules.js';

export type IssueSeverity = 'BLOCKER' | 'WARNING';

export type RunIssue = {
	readonly severity: IssueSeverity;
	readonly code: string;
	readonly message: string;
	readonly collection?: string;
	readonly recordId?: string;
};

/** Configuration checks. None of them read a person. */
export function validateConfiguration(configuration: Configuration): RunIssue[] {
	const issues: RunIssue[] = [];
	const blocker = (code: string, message: string, collection?: string, recordId?: string): void => {
		issues.push({ severity: 'BLOCKER', code, message, collection, recordId });
	};

	if (configuration.jurisdiction.proration == null)
		blocker(
			'PRORATION_MISSING',
			`Jurisdiction ${configuration.jurisdiction.code} states no proration basis, so a partial ` +
				'month cannot be paid.',
			'jurisdictions',
			configuration.jurisdiction.norbital_id
		);

	// ── the grid: every type the catalogue uses must have a decided cell for every scheme ───────
	const usedTypeIds = new Set(
		configuration.payComponents.map((component) => component.component_type_id)
	);
	for (const typeId of usedTypeIds) {
		const type = configuration.componentTypeById.get(typeId);
		if (!type) {
			blocker(
				'COMPONENT_TYPE_MISSING',
				'A pay component points at a component type that does not exist.',
				'pay_components'
			);
			continue;
		}
		if (type.nature === 'INFORMATION') continue;
		for (const contribution of configuration.contributions) {
			const cell = configuration.treatments.get(`${typeId}:${contribution.row.norbital_id}`);
			if (cell?.treatment == null) {
				blocker(
					'TREATMENT_MISSING',
					`No ${contribution.row.code} treatment exists for ${type.code}. The grid is generated ` +
						'for every pair, so an absent cell is a seeding fault, not a decision.',
					'contribution_treatments'
				);
				continue;
			}
			if (cell.treatment.kind === 'UNSET')
				blocker(
					'TREATMENT_UNSET',
					`${type.code} × ${contribution.row.code} is undecided. Payroll cannot guess whether ` +
						'this kind of pay is chargeable.',
					'contribution_treatments',
					cell.norbital_id
				);
			if (
				cell.treatment.kind === 'SPECIAL' &&
				!contribution.row.special_rules.includes(cell.treatment.rule)
			)
				blocker(
					'SPECIAL_RULE_UNKNOWN',
					`${type.code} × ${contribution.row.code} names special rule "${cell.treatment.rule}", ` +
						`which ${contribution.row.code} does not declare.`,
					'contribution_treatments',
					cell.norbital_id
				);
		}
	}

	// ── the schemes ─────────────────────────────────────────────────────────────────────────────
	const sequenceById = new Map(
		configuration.contributions.map((entry) => [entry.row.norbital_id, Number(entry.row.sequence)])
	);
	for (const contribution of configuration.contributions) {
		const code = contribution.row.code;
		try {
			parseSpecialRules(contribution.row.special_rules, code);
		} catch (error) {
			blocker(
				'SPECIAL_RULE_INVALID',
				error instanceof Error ? error.message : String(error),
				'statutory_contributions',
				contribution.row.norbital_id
			);
		}
		if (contribution.rates.length === 0)
			blocker(
				'CONTRIBUTION_UNBANDED',
				`${code} has no rate bands effective for this period, so it could not charge anything.`,
				'statutory_contributions',
				contribution.row.norbital_id
			);
		const hasTerminalBand = contribution.rates.some((rate) => {
			const selector = rate.selector;
			if (selector == null) return false;
			return (selector.by === 'WAGE' || selector.by === 'WAGE_AND_AGE') && selector.to == null;
		});
		const isWageBanded =
			contribution.row.keyed_by === 'WAGE' || contribution.row.keyed_by === 'WAGE_AND_AGE';
		if (isWageBanded && contribution.rates.length > 0 && !hasTerminalBand)
			blocker(
				'CONTRIBUTION_NO_CEILING',
				`${code} has no open-ended terminal band. A ceiling is expressed as a band with no upper ` +
					'bound; without one, a wage above the highest band cannot be charged at all.',
				'contribution_rates',
				contribution.row.norbital_id
			);
		for (const relievedId of contribution.row.relief_for) {
			const relievedSequence = sequenceById.get(relievedId);
			if (relievedSequence == null) {
				blocker(
					'RELIEF_TARGET_MISSING',
					`${code} is a relief for a contribution that is not effective in this jurisdiction.`,
					'statutory_contributions',
					contribution.row.norbital_id
				);
				continue;
			}
			if (relievedSequence <= Number(contribution.row.sequence))
				blocker(
					'RELIEF_ORDER',
					`${code} is a relief inside a contribution that runs before it. A relief must be ` +
						'produced before the scheme that consumes it.',
					'statutory_contributions',
					contribution.row.norbital_id
				);
		}
	}

	// ── overtime completeness: a stated rule nobody pays is work done for nothing ────────────────
	const mappedRules = new Set(
		configuration.payComponents.flatMap((component) => {
			const definition = component.definition;
			if (definition == null || definition.source !== 'OVERTIME') return [];
			return [
				`${definition.rule.day_type}:${definition.rule.measure}:${definition.rule.band_from}`
			];
		})
	);
	for (const rule of configuration.overtimeRules) {
		const band = rule.band;
		if (band == null) {
			blocker(
				'OVERTIME_RULE_UNBANDED',
				`An overtime rule (${rule.authority}) carries no band and can never be entered.`,
				'overtime_rules',
				rule.norbital_id
			);
			continue;
		}
		const from = band.measure === 'BEYOND_NORMAL' ? band.from_hours : band.from_fraction;
		const key = `${rule.day_type}:${band.measure}:${from}`;
		if (mappedRules.has(key)) continue;
		// A day-wage rule is only reachable under the statutory rest-day reading, so an unmapped one
		// is a warning rather than a blocker while the hourly reading is in force.
		issues.push({
			severity: band.measure === 'FROM_START_OF_DAY' ? 'WARNING' : 'BLOCKER',
			code: 'OVERTIME_RULE_UNMAPPED',
			message:
				`${configuration.jurisdiction.code} defines ${rule.day_type} ${band.measure} from ${from} ` +
				`(${rule.authority}); this company has no pay component for it. Work under that rule ` +
				'would be unpaid.',
			collection: 'overtime_rules',
			recordId: rule.norbital_id
		});
	}

	return issues;
}

/** The overtime ceilings that only a measured run can test. */
export function validateOvertimeLimits(options: {
	readonly configuration: Configuration;
	readonly employeeNumber: string;
	readonly calendarMonth: string;
	readonly monthHours: number;
}): RunIssue[] {
	return options.configuration.overtimeLimits
		.filter((limit) => limit.period === 'MONTH' && options.monthHours > Number(limit.max_hours))
		.map((limit) => ({
			severity: limit.on_exceed === 'BLOCK' ? ('BLOCKER' as const) : ('WARNING' as const),
			code: 'OVERTIME_LIMIT_EXCEEDED',
			message:
				`${options.employeeNumber} worked ${options.monthHours} regulated overtime hours in ` +
				`${options.calendarMonth}, against a ${limit.max_hours}-hour calendar-month ceiling ` +
				`(${limit.authority}).`,
			collection: 'overtime_limits',
			recordId: limit.norbital_id
		}));
}

/** Work beyond 12 hours is paid through incentive OT but remains a compliance warning. */
export function validateDailyWorkLimit(options: {
	readonly employeeNumber: string;
	readonly days: readonly DailyOvertime[];
	readonly maxWorkHours: number;
}): RunIssue[] {
	return options.days
		.filter((day) => day.totalWorkHours > options.maxWorkHours)
		.map((day) => ({
			severity: 'WARNING' as const,
			code: 'DAILY_WORK_LIMIT_EXCEEDED',
			message:
				`${options.employeeNumber} worked ${day.totalWorkHours.toFixed(2)} hours on ${day.date}, ` +
				`above the ${options.maxWorkHours}-hour daily limit. Any payable half-hour excess was ` +
				'routed to incentive OT; payment does not cure the hours-of-work breach.',
			collection: 'time_entries',
			recordId: day.timeEntryId
		}));
}

/**
 * Whether the company's pay calendar can express the cadence its people are actually paid on.
 *
 * `companies.pay_cutoff_day` and `pay_day` are one integer each, so they describe a **monthly**
 * calendar and nothing else — one window, one pay date, one run per month. An employment whose
 * terms say `SEMI_MONTHLY` is paid on a cadence this company cannot state, and payroll runs it on
 * the monthly calendar because that is the only calendar there is.
 *
 * That is a gap in the model, not a fault in the data, and it is reported rather than papered over:
 * silently paying a semi-monthly employee once a month on the monthly window is exactly the kind of
 * quiet wrong answer a warning exists for. Closing it needs `companies` to be able to hold more
 * than one cutoff and pay date, and `payroll_runs.period` to be able to name half a month.
 */
export function validatePayCalendar(options: {
	readonly configuration: Configuration;
	readonly bundles: readonly {
		readonly employment: { readonly employee_number: string; readonly norbital_id: string };
		readonly terms: readonly { readonly pay_frequency: string | null }[];
	}[];
}): RunIssue[] {
	const mismatched = options.bundles.filter((bundle) =>
		bundle.terms.some((row) => row.pay_frequency != null && row.pay_frequency !== 'MONTHLY')
	);
	if (mismatched.length === 0) return [];
	const cadences = [
		...new Set(
			mismatched.flatMap((bundle) =>
				bundle.terms.map((row) => row.pay_frequency).filter((value) => value !== 'MONTHLY')
			)
		)
	].join(', ');
	return [
		{
			severity: 'WARNING',
			code: 'PAY_CALENDAR_CADENCE_UNSUPPORTED',
			message:
				`${mismatched.length} employment(s) at ${options.configuration.company.name} are on ${cadences} ` +
				'terms, but a company states one cutoff day and one pay day, which can only describe a ' +
				'monthly calendar. They are being run on the monthly window ' +
				`(${options.configuration.company.pay_cutoff_day}) because there is no other one to run them on.`,
			collection: 'companies',
			recordId: options.configuration.company.norbital_id
		}
	];
}

export function blockers(issues: readonly RunIssue[]): RunIssue[] {
	return issues.filter((issue) => issue.severity === 'BLOCKER');
}

export function describeBlockers(issues: readonly RunIssue[]): string {
	const found = blockers(issues);
	const codes = [...new Set(found.map((issue) => issue.code))].join(', ');
	const detail = [...new Set(found.map((issue) => issue.message))].slice(0, 3).join(' ');
	return `Payroll is blocked (${codes}). ${detail}`;
}
