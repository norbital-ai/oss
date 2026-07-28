/**
 * Step 6 — CONTRIBUTE.
 *
 * A contribution turns a base into an employee amount and an employer amount. It never knows what
 * produced the base.
 *
 * ```
 * 1  SELECT BAND   by contribution_rates.selector — bands.ts
 * 2  APPLY AWARD   PERCENT · FIXED · PROGRESSIVE, or an employment's explicit flat override
 * 3  ROUND         contribution.rounding, or a ROUND: chain, never a formula
 * 4  GATE          employment_statutory_facts: NOT_REGISTERED pays nothing
 * ```
 *
 * Schemes run in `sequence` order, so a scheme that is a relief inside another has already produced
 * its number when that other one reads it. `relief_for` says *this scheme's employee share is a
 * relief inside that scheme's computation* — it never reduces a base.
 *
 * ## PROGRESSIVE is cumulative, and this is the single most expensive detail in the engine
 *
 * A progressive band's `constant` is the **accumulated tax on every preceding band**, less whatever
 * rebate the jurisdiction folds in — not a flat addend:
 *
 * ```
 * tax = constant + (chargeable − band_from) × rate / 100
 * ```
 *
 * Read as a flat addend (`rate × chargeable + constant`) a chargeable income of 44,111.40 yields
 * 3,246.68 where the correct answer is 600 + 9,111.40 × 0.06 = **1,146.68** — a 175.00 monthly
 * error on one mid-band employee, and the error grows with income without bound. The seeded
 * Malaysian scale reconciles exactly, band by band, as cumulative tax (decision E1 / risk register
 * #2).
 */

import { bandFloor, bandReference, selectBand, type BandContext } from './bands.js';
import type { ContributionConfig } from './configuration.js';
import type { ContributionBase } from './accumulate.js';
import { roundMoney, type RoundingMethod } from './rounding.js';
import {
	ADDITIONAL_REMUNERATION,
	bracketBase,
	parseSpecialRules,
	type SpecialRules
} from './special-rules.js';

export type StatutoryFactStatus = {
	readonly kind: 'REGISTERED' | 'NOT_REGISTERED';
	/** Percentage award; on a progressive scheme this is a flat current-remuneration rate. */
	readonly rate_override: number | null;
};

export type ContributionCharge = {
	readonly contribution: ContributionConfig;
	readonly base: number;
	readonly employee: number;
	readonly employer: number;
	readonly bandReference: string | null;
	readonly special: Readonly<Record<string, number>>;
};

export type ContributeInput = {
	readonly bases: readonly ContributionBase[];
	/** `contribution_id` → the employment's registration, or `null` where no row exists. */
	readonly facts: ReadonlyMap<string, StatutoryFactStatus>;
	/** `contribution_code` → what has already been charged this tax year. */
	readonly yearToDate: (code: string) => { employee: number; employer: number; base: number };
	readonly age: number | null;
	readonly headcount: number;
	readonly riskClass: string | null;
	/** This period included. */
	readonly periodsRemaining: number;
	/**
	 * Whether the employee's spouse is a dependant — a spouse who exists and has no total income
	 * of their own. That, not the fact of a marriage, is what a spouse relief and a married
	 * withholding scale both turn on (ITA 1967 s.47; MTD Category 2).
	 */
	readonly spouseIsDependent: boolean;
	readonly dependents: number;
};

/**
 * A rate is a PERCENTAGE NUMBER, never a fraction: `{kind:'PERCENT', employee: 11}` is 11%, and
 * `{kind:'PROGRESSIVE', rate: 3}` is a 3% marginal rate. That is how every statute states a rate,
 * how the `rate_award` editor labels the field ("Employee (%)"), and what the seeded law declares
 * (source-system convention C4). The division by 100 happens here
 * and NOWHERE else, so a rate can be read off a gazette and typed straight into a row.
 */
function asFraction(rate: number): number {
	return rate / 100;
}

function roundingFor(contribution: ContributionConfig, rules: SpecialRules): RoundingMethod[] {
	return rules.roundingChain.length > 0
		? [...rules.roundingChain]
		: [contribution.row.rounding as RoundingMethod];
}

function applyRounding(value: number, chain: readonly RoundingMethod[]): number {
	return chain.reduce((running, method) => roundMoney(running, method), value);
}

function roundContributionShares(
	employee: number,
	employer: number,
	chain: readonly RoundingMethod[],
	rules: SpecialRules
): { employee: number; employer: number } {
	if (rules.totalRoundedEmployeeFloored) {
		const roundedEmployee = roundMoney(employee, 'FLOOR_UNIT');
		const roundedTotal = roundMoney(employee + employer, 'NEAREST_UNIT');
		return { employee: roundedEmployee, employer: roundedTotal - roundedEmployee };
	}
	return {
		employee: applyRounding(employee, chain),
		employer: applyRounding(employer, chain)
	};
}

/**
 * Whether a scheme charges at all.
 *
 * An unregistered employment contributes nothing, and therefore also contributes nothing to any
 * relief pool it feeds — the pool is fed by the *output*, never by a rate.
 */
function isRegistered(status: StatutoryFactStatus | undefined): boolean {
	return status == null || status.kind === 'REGISTERED';
}

/** Everything one scheme produced, so the schemes that read it can find it. */
type Produced = {
	readonly employee: number;
	readonly employer: number;
	readonly rules: SpecialRules;
};

export function contribute(input: ContributeInput): ContributionCharge[] {
	const charges: ContributionCharge[] = [];
	const produced = new Map<string, Produced>();

	for (const entry of input.bases) {
		const contribution = entry.contribution;
		const code = contribution.row.code;
		const rules = parseSpecialRules(contribution.row.special_rules, code);
		const status = input.facts.get(contribution.row.norbital_id);

		if (!isRegistered(status) || entry.base <= 0) {
			produced.set(code, { employee: 0, employer: 0, rules });
			charges.push({
				contribution,
				base: entry.base,
				employee: 0,
				employer: 0,
				bandReference: null,
				special: entry.special
			});
			continue;
		}

		// The band is chosen on the base as accumulated; the *award* is applied to the bracketed
		// base. EPF's employer rate switches at RM5,000 of actual wage, and a wage of 4,995 brackets
		// up to 5,000 while still earning the higher rate — keying the switch on the bracketed figure
		// flips roughly one employee in 250 to the wrong rate.
		const context: BandContext = {
			base: entry.base,
			age: input.age,
			headcount: input.headcount,
			riskClass: input.riskClass,
			marital: input.spouseIsDependent ? 'MARRIED' : 'SINGLE'
		};
		const band = selectBand(contribution.rates, context, code);
		const awardBase = bracketBase(entry.base, rules.bracketSteps);
		const chain = roundingFor(contribution, rules);
		const hasFlatOverride = status?.kind === 'REGISTERED' && status.rate_override != null;

		let employee = 0;
		let employer = 0;
		switch (band.award.kind) {
			case 'PERCENT': {
				const employeeRate = hasFlatOverride ? status.rate_override : band.award.employee;
				({ employee, employer } = roundContributionShares(
					awardBase * asFraction(employeeRate),
					awardBase * asFraction(band.award.employer),
					chain,
					rules
				));
				break;
			}
			case 'FIXED': {
				// A tabled amount is the published figure. Rounding it would move every SOCSO and EIS
				// employer share by a cent or two, so `TABLE` rounding is the identity.
				({ employee, employer } = roundContributionShares(
					band.award.employee,
					band.award.employer,
					chain,
					rules
				));
				break;
			}
			case 'PROGRESSIVE':
				// A progressive-scheme override is a flat statutory award on current remuneration,
				// not a replacement marginal band inside the resident scale. Malaysia uses this for
				// a proven non-resident employee: 30% of remuneration, without resident reliefs.
				employee = hasFlatOverride
					? applyRounding(entry.base * asFraction(status.rate_override), chain)
					: progressiveWithholding({ entry, contribution, rules, input, produced, chain });
				employer = 0;
				break;
		}

		produced.set(code, { employee, employer, rules });
		charges.push({
			contribution,
			base: entry.base,
			employee,
			employer,
			bandReference:
				band.award.kind === 'PROGRESSIVE' && hasFlatOverride ? null : bandReference(band.selector),
			special: entry.special
		});
	}
	return charges;
}

/** `constant + (value − band_from) × rate%`, over the scheme's own bands. */
export function scaleProgressive(
	contribution: ContributionConfig,
	value: number,
	context: BandContext
): number {
	if (value <= 0) return 0;
	const band = selectBand(contribution.rates, { ...context, base: value }, contribution.row.code);
	if (band.award.kind !== 'PROGRESSIVE')
		throw new Error(
			`${contribution.row.code} band ${bandReference(band.selector)} is not a progressive award, ` +
				'so a chargeable income cannot be scaled through it.'
		);
	return band.award.constant + (value - bandFloor(band.selector)) * asFraction(band.award.rate);
}

/**
 * The five steps of a withholding tax.
 *
 * ```
 * 1  PROJECT     annual = year-to-date base + this period's base × periods remaining
 * 2  RELIEVE     personal, spouse, dependants, and the pooled statutory reliefs
 * 3  SCALE       the progressive band ladder, cumulative
 * 4  SPREAD      (annual tax − already withheld) / periods remaining
 * 5  ADDITIONAL  scale(chargeable + A) − scale(chargeable), for bonus-shaped pay
 * ```
 *
 * The relief pools are deliberately **asymmetric**, and that asymmetry is the law rather than an
 * oversight: a retirement-fund relief is projected across the months still to run, because the
 * employee will certainly keep contributing, while a social-security relief counts only what has
 * actually been paid. Projecting both would overstate relief by up to eleven months' worth early in
 * the year and change the tax of every mid-band employee (decision E9).
 */
function progressiveWithholding(options: {
	readonly entry: ContributionBase;
	readonly contribution: ContributionConfig;
	readonly rules: SpecialRules;
	readonly input: ContributeInput;
	readonly produced: ReadonlyMap<string, Produced>;
	readonly chain: readonly RoundingMethod[];
}): number {
	const { entry, contribution, rules, input } = options;
	const code = contribution.row.code;
	const remaining = Math.max(1, input.periodsRemaining);
	const priorBase = input.yearToDate(code).base;

	// A jurisdiction may publish a table for the payroll period itself. In that case annualising a
	// monthly threshold and then spreading the result applies the table twelve times over. Current
	// mandatory employee contributions are still deducted because their rows explicitly name this
	// scheme in `relief_for`; no year-to-date or future projection belongs in a period table.
	if (rules.periodicProgressive) {
		const statutoryRelief = input.bases.reduce((total, other) => {
			if (!other.contribution.row.relief_for.includes(contribution.row.norbital_id)) return total;
			return total + (options.produced.get(other.contribution.row.code)?.employee ?? 0);
		}, 0);
		const chargeable = Math.max(0, entry.base - statutoryRelief);
		const context: BandContext = {
			base: chargeable,
			age: input.age,
			headcount: input.headcount,
			riskClass: input.riskClass,
			marital: input.spouseIsDependent ? 'MARRIED' : 'SINGLE'
		};
		const regular = applyRounding(
			scaleProgressive(contribution, chargeable, context),
			options.chain
		);
		return regular < rules.minWithhold ? 0 : regular;
	}

	// 1 — PROJECT
	const annualGross = priorBase + entry.base * remaining;

	// 2 — RELIEVE
	const pools = new Map<string, { total: number; cap: number | null }>();
	for (const other of input.bases) {
		const otherCode = other.contribution.row.code;
		if (!other.contribution.row.relief_for.includes(contribution.row.norbital_id)) continue;
		const result = options.produced.get(otherCode);
		if (result == null) continue;
		const priorEmployee = input.yearToDate(otherCode).employee;
		let relievable = priorEmployee + result.employee;
		if (result.rules.reliefProjected && result.rules.reliefCap != null) {
			const future = remaining - 1;
			const remainingCap = Math.min(
				Math.max(0, result.rules.reliefCap - relievable),
				result.rules.reliefCap
			);
			if (future > 0) relievable += Math.min(result.employee, remainingCap / future) * future;
		}
		const poolKey = result.rules.reliefPool ?? otherCode;
		const pool = pools.get(poolKey) ?? { total: 0, cap: result.rules.reliefCap };
		pools.set(poolKey, {
			total: pool.total + relievable,
			cap:
				pool.cap == null
					? result.rules.reliefCap
					: result.rules.reliefCap == null
						? pool.cap
						: Math.min(pool.cap, result.rules.reliefCap)
		});
	}
	const statutoryRelief = [...pools.values()].reduce(
		(total, pool) => total + (pool.cap == null ? pool.total : Math.min(pool.total, pool.cap)),
		0
	);
	const personalRelief =
		rules.personalRelief +
		(input.spouseIsDependent ? rules.spouseRelief : 0) +
		rules.childRelief * Math.max(0, input.dependents);
	const chargeable = Math.max(0, annualGross - statutoryRelief - personalRelief);

	// 3 & 4 — SCALE, then SPREAD what has not already been withheld
	const bandContext: BandContext = {
		base: chargeable,
		age: input.age,
		headcount: input.headcount,
		riskClass: input.riskClass,
		marital: input.spouseIsDependent ? 'MARRIED' : 'SINGLE'
	};
	const annualTax = scaleProgressive(contribution, chargeable, bandContext);
	const alreadyWithheld = input.yearToDate(code).employee;
	const regular = applyRounding(
		Math.max(0, annualTax - alreadyWithheld) / remaining,
		options.chain
	);

	// 5 — ADDITIONAL. The extra is the difference two scalings make, and it is charged on top of the
	// regular part whatever the minimum-withholding threshold did to that part.
	const additional = rules.additionalRemuneration
		? (entry.special[ADDITIONAL_REMUNERATION] ?? 0)
		: 0;
	const extra =
		additional > 0
			? applyRounding(
					Math.max(
						0,
						scaleProgressive(contribution, chargeable + additional, bandContext) - annualTax
					),
					options.chain
				)
			: 0;

	const suppressed = regular < rules.minWithhold ? 0 : regular;
	return suppressed + extra;
}
