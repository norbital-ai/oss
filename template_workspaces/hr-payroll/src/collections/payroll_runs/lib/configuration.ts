/**
 * Step 1 — PICK.
 *
 * Resolve everything the run is governed by, as of the period end, once: the jurisdiction, its
 * statutory contributions and their bands, the treatment grid, the overtime rules and limits, the
 * company's pay catalogue, its shifts, its holidays and its leave policy. Nothing downstream reads
 * configuration again, so a row end-dated halfway through a build cannot change an answer under it.
 *
 * The picked set is hashed into `payroll_runs.configuration_hash`. The hash is an **audit token**,
 * not a replay key: it says "these rows produced these payslips", and a rebuild that yields a
 * different hash is a rebuild against different law (decisions E32 / L29 / L30).
 */

import { sha256Json } from '@norbital-ai/std/reckon';
import type { WorkspaceRow } from '../$types.js';
import { assertComplete, PAGE_LIMIT, type PayrollReadApi } from './api.js';
import { bandAgeFloor, bandCeiling } from './bands.js';
import { monthBounds, monthKey, type IsoDate } from './dates.js';
import { coverageRuleFor } from './coverage.js';
import { coversDate, effectiveOn, live, overlapsRange } from './effective.js';
import { resolveRestBreakRules, type ResolvedRestBreakRule } from './rest-breaks.js';

export type Company = WorkspaceRow<'companies'>;
export type Jurisdiction = WorkspaceRow<'jurisdictions'>;
export type PayComponent = WorkspaceRow<'pay_components'>;
export type OvertimeRule = WorkspaceRow<'overtime_rules'>;
export type OvertimeLimit = WorkspaceRow<'overtime_limits'>;
export type OvertimeCoverageRule = WorkspaceRow<'overtime_coverage_rules'>;
export type RestBreakRuleRow = WorkspaceRow<'rest_break_rules'>;
export type ShiftDefinition = WorkspaceRow<'shift_definitions'>;
export type LeaveType = WorkspaceRow<'leave_types'>;
export type WorkPattern = WorkspaceRow<'work_patterns'>;
export type ContributionRate = WorkspaceRow<'contribution_rates'>;
export type Treatment = NonNullable<PayComponent['policy']>['statutory_treatments'][number];
export type StatutoryContribution = WorkspaceRow<'statutory_contributions'>;

/** One statutory scheme with the bands that were effective when the run was picked. */
export type ContributionConfig = {
	readonly row: StatutoryContribution;
	readonly rates: readonly ContributionRate[];
};

export type Configuration = {
	readonly company: Company;
	readonly jurisdiction: Jurisdiction;
	/** In `sequence` order — a relief is produced before the scheme that consumes it. */
	readonly contributions: readonly ContributionConfig[];
	/** `${pay_component_id}:${statutory_contribution_id}` → the one effective cell. */
	readonly treatments: ReadonlyMap<string, Treatment>;
	/** In `sequence` order — the order MEASURE walks. */
	readonly payComponents: readonly PayComponent[];
	readonly overtimeRules: readonly OvertimeRule[];
	readonly overtimeLimits: readonly OvertimeLimit[];
	/**
	 * Who the ladder covers, or null where the jurisdiction restricts coverage in no way.
	 *
	 * Null is a real answer and is not the same as "nobody is covered" — see `coverage.ts`.
	 */
	readonly overtimeCoverageRule: OvertimeCoverageRule | null;
	/**
	 * The statutory rest and meal breaks in force, resolved by when they bite — see
	 * `rest-breaks.ts`. Picked with the rest of the law so a run can say which break rules
	 * governed it; nothing prices them yet.
	 */
	readonly restBreakRules: ReadonlyMap<string, ResolvedRestBreakRule>;
	readonly shiftById: ReadonlyMap<string, ShiftDefinition>;
	readonly holidays: ReadonlyMap<IsoDate, WorkspaceRow<'company_holidays'>>;
	readonly leaveTypes: readonly LeaveType[];
	/** Keyed by id, because employment terms name the exact pattern that governs them. */
	readonly workPatternById: ReadonlyMap<string, WorkPattern>;
	readonly hash: string;
};

function treatmentKey(payComponentId: string, contributionId: string): string {
	return `${payComponentId}:${contributionId}`;
}

export function lookupTreatment(
	configuration: Pick<Configuration, 'treatments'>,
	payComponentId: string,
	contributionId: string
): Treatment | undefined {
	return configuration.treatments.get(treatmentKey(payComponentId, contributionId));
}

/**
 * Bands ascending by ceiling; the open-ended band sorts last, then by age floor.
 *
 * A band whose selector is missing sorts first so that `selectBand` reaches it and reports the
 * seeding fault by name, rather than the order silently hiding it at the end of the ladder.
 */
function bandOrder(left: ContributionRate, right: ContributionRate): number {
	const ceiling = (rate: ContributionRate): number =>
		rate.selector == null ? Number.NEGATIVE_INFINITY : bandCeiling(rate.selector);
	const ageFloor = (rate: ContributionRate): number =>
		rate.selector == null ? 0 : bandAgeFloor(rate.selector);
	return ceiling(left) - ceiling(right) || ageFloor(left) - ageFloor(right);
}

/**
 * Load the configuration governing one company for one period.
 *
 * Everything is resolved as of the period end, except shifts and holidays, which are read across
 * the whole attendance window because a shift may legitimately be revised inside it.
 */
export async function pickConfiguration(options: {
	readonly api: PayrollReadApi;
	readonly companyId: string;
	readonly period: string;
	readonly salary: { readonly start: IsoDate; readonly end: IsoDate };
	readonly attendance: { readonly start: IsoDate; readonly end: IsoDate };
}): Promise<Configuration> {
	const { query } = options.api.db;
	const asOf = options.salary.end;
	const rawWindowStart =
		options.attendance.start < options.salary.start
			? options.attendance.start
			: options.salary.start;
	const rawWindowEnd =
		options.attendance.end > options.salary.end ? options.attendance.end : options.salary.end;
	// OT is paid on the attendance cutoff, but statutory limits and substitute holidays are
	// determined by calendar month. Pick every shift touching the full calendar months involved.
	const windowStart = monthBounds(monthKey(rawWindowStart)).start;
	const windowEnd = monthBounds(monthKey(rawWindowEnd)).end;
	const approved = { norbital_approval_id: { isNull: true } } as const;

	const companies = await query.companies.findMany({
		where: { norbital_id: { eq: options.companyId }, ...approved },
		limit: 100
	});
	const company = effectiveOn(companies, asOf);
	if (!company) throw new Error(`No company ${options.companyId} is effective on ${asOf}.`);

	const jurisdictions = await query.jurisdictions.findMany({
		where: { norbital_id: { eq: company.jurisdiction_id }, ...approved },
		limit: 100
	});
	const jurisdiction = effectiveOn(jurisdictions, asOf);
	if (!jurisdiction)
		throw new Error(`Company ${company.name} has no jurisdiction effective on ${asOf}.`);

	const [
		contributionRows,
		payComponentRows,
		overtimeRuleRows,
		overtimeLimitRows,
		overtimeCoverageRuleRows,
		restBreakRuleRows,
		shiftRows,
		holidayRows,
		leaveTypeRows,
		workPatternRows
	] = await Promise.all([
		query.statutory_contributions.findMany({
			where: { jurisdiction_id: { eq: jurisdiction.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.pay_components.findMany({
			where: { company_id: { eq: company.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.overtime_rules.findMany({
			where: { jurisdiction_id: { eq: jurisdiction.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.overtime_limits.findMany({
			where: { jurisdiction_id: { eq: jurisdiction.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.overtime_coverage_rules.findMany({
			where: { jurisdiction_id: { eq: jurisdiction.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.rest_break_rules.findMany({
			where: { jurisdiction_id: { eq: jurisdiction.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.shift_definitions.findMany({
			where: { company_id: { eq: company.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.company_holidays.findMany({
			where: { company_id: { eq: company.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.leave_types.findMany({
			where: { company_id: { eq: company.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		}),
		query.work_patterns.findMany({
			where: { company_id: { eq: company.norbital_id }, ...approved },
			limit: PAGE_LIMIT
		})
	]);
	// Every collection pages to the same ceiling and is checked: a configuration read that came
	// back truncated would drop law — a missing holiday, a missing band — and still produce a
	// payslip, which is the one outcome worse than producing none.
	assertComplete(contributionRows, 'statutory contributions');
	assertComplete(payComponentRows, 'pay components');
	assertComplete(overtimeRuleRows, 'overtime rules');
	assertComplete(overtimeLimitRows, 'overtime limits');
	assertComplete(overtimeCoverageRuleRows, 'overtime coverage rules');
	assertComplete(restBreakRuleRows, 'rest break rules');
	assertComplete(shiftRows, 'shift definitions');
	assertComplete(holidayRows, 'company holidays');
	assertComplete(leaveTypeRows, 'leave types');
	assertComplete(workPatternRows, 'work patterns');

	const contributions = live(contributionRows)
		.filter((row) => coversDate(row.effective_range, asOf))
		.toSorted((left, right) => Number(left.sequence) - Number(right.sequence));

	const contributionIds = contributions.map((row) => row.norbital_id);
	const rateRows = contributionIds.length
		? await query.contribution_rates.findMany({
				where: { statutory_contribution_id: { in: contributionIds }, ...approved },
				limit: PAGE_LIMIT
			})
		: [];
	assertComplete(rateRows, 'contribution rates');

	const ratesByContribution = new Map<string, ContributionRate[]>();
	for (const rate of live(rateRows)) {
		if (!coversDate(rate.effective_range, asOf)) continue;
		const bucket = ratesByContribution.get(rate.statutory_contribution_id);
		if (bucket) bucket.push(rate);
		else ratesByContribution.set(rate.statutory_contribution_id, [rate]);
	}

	const payComponents = live(payComponentRows)
		.filter((row) => coversDate(row.effective_range, asOf))
		.toSorted((left, right) => Number(left.sequence) - Number(right.sequence));
	const treatments = new Map<string, Treatment>();
	for (const component of payComponents) {
		for (const treatment of component.policy?.statutory_treatments ?? []) {
			if (
				!contributionIds.includes(treatment.statutory_contribution_id) ||
				!coversDate(treatment.effective_range, asOf)
			)
				continue;
			const key = treatmentKey(component.norbital_id, treatment.statutory_contribution_id);
			if (treatments.has(key))
				throw new Error(
					`Pay component ${component.code} has overlapping statutory treatments for ${treatment.statutory_contribution_id}.`
				);
			treatments.set(key, treatment);
		}
	}

	const shifts = live(shiftRows).filter((row) =>
		overlapsRange(row.effective_range, windowStart, windowEnd)
	);

	// Keyed by id rather than filtered to one effective row: the terms name the exact pattern that
	// governs them, and the terms row's own effective range already decides which terms apply when.
	const workPatterns = live(workPatternRows).filter((row) =>
		overlapsRange(row.effective_range, windowStart, windowEnd)
	);

	const configuration = {
		company,
		jurisdiction,
		contributions: contributions.map((row) => ({
			row,
			rates: (ratesByContribution.get(row.norbital_id) ?? []).toSorted(bandOrder)
		})),
		treatments,
		payComponents,
		overtimeRules: live(overtimeRuleRows).filter((row) => coversDate(row.effective_range, asOf)),
		overtimeLimits: live(overtimeLimitRows).filter((row) => coversDate(row.effective_range, asOf)),
		overtimeCoverageRule: coverageRuleFor(
			live(overtimeCoverageRuleRows).filter((row) => coversDate(row.effective_range, asOf))
		),
		restBreakRules: resolveRestBreakRules(
			live(restBreakRuleRows).filter((row) => coversDate(row.effective_range, asOf))
		),
		shiftById: new Map(shifts.map((row) => [row.norbital_id, row])),
		holidays: new Map(
			live(holidayRows).map((row) => [String(row.date).slice(0, 10), row] as const)
		),
		leaveTypes: live(leaveTypeRows).filter((row) => coversDate(row.effective_range, asOf)),
		workPatternById: new Map(workPatterns.map((row) => [row.norbital_id, row]))
	} satisfies Omit<Configuration, 'hash'>;

	return { ...configuration, hash: hashConfiguration(configuration, options.period) };
}

/**
 * Hash the picked configuration. Only what governs the arithmetic is included — never the
 * population, never a timestamp — so two builds of the same month against unchanged law hash alike
 * and a changed hash always means changed law.
 */
export function configurationSnapshot(
	configuration: Omit<Configuration, 'hash'>,
	period: string
): Record<string, unknown> {
	return {
		period,
		company: configuration.company.norbital_id,
		jurisdiction: configuration.jurisdiction.norbital_id,
		proration: configuration.jurisdiction.proration,
		rounding: configuration.jurisdiction.rounding,
		ordinary_rate: [
			configuration.jurisdiction.ordinary_rate_basis,
			configuration.jurisdiction.ordinary_rate_divisor
		],
		tax_year_start_month: configuration.jurisdiction.tax_year_start_month,
		pay_calendar: [configuration.company.pay_cutoff_day, configuration.company.pay_day],
		overtime_calculation_method: configuration.company.overtime_calculation_method,
		// Settlement is part of the law a payslip was computed under: change when a joining period
		// settles and the same month produces a different set of payslips, so a rebuild must hash
		// differently rather than look like the same answer.
		settlement_policy: configuration.company.settlement_policy,
		contributions: configuration.contributions.map((entry) => ({
			code: entry.row.code,
			sequence: entry.row.sequence,
			payer: entry.row.payer,
			keyed_by: entry.row.keyed_by,
			rounding: entry.row.rounding,
			special_rules: [...entry.row.special_rules].toSorted(),
			relief_for: [...entry.row.relief_for].toSorted(),
			rates: entry.rates.map((rate) => [rate.selector, rate.award])
		})),
		treatments: [...configuration.treatments]
			.map(([key, treatment]) => [key, treatment.treatment])
			.toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
		pay_components: configuration.payComponents
			.map((row) => [row.code, row.policy, row.sequence, row.definition, row.eligibility])
			.toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
		overtime_rules: configuration.overtimeRules
			.map((row) => [row.day_type, row.band, row.award])
			.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
		overtime_limits: configuration.overtimeLimits
			.map((row) => [row.period, row.measures, row.max_hours, row.on_exceed])
			.toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
		// Who the ladder covered is as much a part of the law a payslip was computed under as what an
		// hour was worth. Without this a PAID run could not say which wage ceiling priced it, and a
		// First Schedule amendment would rebuild to the same hash as the law it replaced.
		overtime_coverage: configuration.overtimeCoverageRule
			? [
					configuration.overtimeCoverageRule.wage_ceiling,
					configuration.overtimeCoverageRule.ceiling_is_inclusive,
					configuration.overtimeCoverageRule.wage_basis,
					configuration.overtimeCoverageRule.category_basis,
					[...configuration.overtimeCoverageRule.exempt_categories].toSorted(),
					[...configuration.overtimeCoverageRule.excluded_categories].toSorted(),
					configuration.overtimeCoverageRule.authority
				]
			: null,
		// The breaks in force were picked with the rest of the law: a rebuild after an amendment to
		// s.60A must hash differently from the run that priced under the old text, even though no
		// figure on a payslip moves until a check starts reading them.
		rest_break_rules: [...configuration.restBreakRules.values()]
			.map((rule) => [
				rule.appliesWhen,
				rule.afterConsecutiveHours,
				rule.minimumMinutes,
				rule.countsAsWorkedTime,
				rule.authority
			])
			.toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
		holidays: [...configuration.holidays.values()]
			.map((row) => [String(row.date).slice(0, 10), row.substitutes_date, row.scope])
			.toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
		leave_types: configuration.leaveTypes
			.map((row) => [row.code, row.accrual, row.entitlement, row.payroll_effect])
			.toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
		// A pattern decides which days are rest, off and ordinary, so changing one reprices days.
		// The scheduling limits are deliberately absent: they gate whether a roster may be published,
		// and never enter the arithmetic of a day already worked.
		work_patterns: [...configuration.workPatternById.values()]
			.map((row) => [row.code, row.variant, row.default_shift_definition_id])
			.toSorted((left, right) => String(left[0]).localeCompare(String(right[0])))
	};
}

function hashConfiguration(configuration: Omit<Configuration, 'hash'>, period: string): string {
	return sha256Json(configurationSnapshot(configuration, period));
}
