/**
 * Selecting a band of a statutory contribution.
 *
 * **A wage band is chosen by its ceiling.** The published PERKESO and EPF schedules read "wages
 * exceeding X but not exceeding Y", so a wage of exactly 4,800.00 belongs to the band ending at
 * 4,800.00, not to the one starting there. Keying on the floor instead shifts every SOCSO and EIS
 * amount by one band — half a ringgit of employee share and 1.75 of employer share on every
 * payslip in the company (decision E3, and the `statutory-band` category of the parity baseline).
 *
 * Non-wage dimensions — age, headcount, risk class — are filters applied first; the wage ceiling
 * then picks one row from what survives. That is what lets EPF, SOCSO and EIS each carry a second
 * age class over the very same wage ladder.
 *
 * A wage above every ceiling is an **error**, never a silent fall back to the last row. A ceiling
 * is expressed as an open-ended terminal band (`to: null`); an engine that quietly reuses the last
 * finite band instead is a wrong-answer generator that nobody can see (decision E24).
 */

import type { ContributionRate } from './configuration.js';

/** The four arms of `rate_selector`. A row whose selector is absent is a data error, not a band. */
export type BandSelector = NonNullable<ContributionRate['selector']>;
export type BandAward = NonNullable<ContributionRate['award']>;

export type BandContext = {
	readonly base: number;
	/** Completed years of age at the period end. `null` where date of birth is unknown. */
	readonly age: number | null;
	/** Active employments in the company at the period end. */
	readonly headcount: number;
	readonly riskClass: string | null;
	/** Which marital category a twice-published scale should be read on. `null` where unknown. */
	readonly marital: 'SINGLE' | 'MARRIED' | null;
};

/**
 * A band row with its variant columns present.
 *
 * `custom()` columns come back nullable whatever the model declares, so the engine states the
 * requirement once, here, rather than testing for it at a dozen call sites. A band without a
 * selector cannot be matched and a band without an award pays nothing — both are seeding faults
 * that must stop a run rather than quietly cost or overcharge someone.
 */
export type ResolvedBand = {
	readonly row: ContributionRate;
	readonly selector: BandSelector;
	readonly award: BandAward;
};

export function resolveBand(rate: ContributionRate, contributionCode: string): ResolvedBand {
	const { selector, award } = rate;
	if (selector == null)
		throw new Error(`A ${contributionCode} rate band has no selector, so nothing can match it.`);
	if (award == null)
		throw new Error(`A ${contributionCode} rate band has no award, so it would pay nothing.`);
	return { row: rate, selector, award };
}

/** Whether a band's non-wage dimensions admit this employment at all. */
function dimensionsMatch(selector: BandSelector, context: BandContext): boolean {
	switch (selector.by) {
		case 'WAGE':
			return true;
		case 'WAGE_AND_AGE': {
			if (context.age == null) return false;
			return (
				context.age >= selector.age_from &&
				(selector.age_to == null || context.age < selector.age_to)
			);
		}
		// An employment whose marital status is unrecorded is read on the SINGLE scale: it is the
		// one every taxpayer qualifies for, so an unknown never claims a relief it may not be owed.
		case 'WAGE_AND_MARITAL':
			return selector.marital === (context.marital ?? 'SINGLE');
		case 'HEADCOUNT':
			return (
				context.headcount >= selector.from &&
				(selector.to == null || context.headcount < selector.to)
			);
		case 'RISK_CLASS':
			return context.riskClass != null && selector.class === context.riskClass;
	}
	throw new Error(`Unsupported band selector: ${Reflect.get(selector, 'by')}`);
}

/**
 * The wage ceiling a band is keyed on.
 *
 * A headcount or risk-class band does not band on the wage at all, so it accepts any base: its one
 * dimension has already been decided by `dimensionsMatch`.
 */
export function bandCeiling(selector: BandSelector): number {
	switch (selector.by) {
		case 'WAGE':
		case 'WAGE_AND_AGE':
		case 'WAGE_AND_MARITAL':
			return selector.to == null ? Number.POSITIVE_INFINITY : selector.to;
		case 'HEADCOUNT':
		case 'RISK_CLASS':
			return Number.POSITIVE_INFINITY;
	}
	throw new Error(`Unsupported band selector: ${Reflect.get(selector, 'by')}`);
}

/** The floor a `PROGRESSIVE` award measures its slice from. */
export function bandFloor(selector: BandSelector): number {
	switch (selector.by) {
		case 'WAGE':
		case 'WAGE_AND_AGE':
		case 'WAGE_AND_MARITAL':
		case 'HEADCOUNT':
			return selector.from;
		case 'RISK_CLASS':
			return 0;
	}
	throw new Error(`Unsupported band selector: ${Reflect.get(selector, 'by')}`);
}

/** The age floor a band applies from, used only to order two bands sharing a ceiling. */
export function bandAgeFloor(selector: BandSelector): number {
	return selector.by === 'WAGE_AND_AGE' ? selector.age_from : 0;
}

/** A human-readable band label, stored on the payslip so a figure can be traced to its row. */
export function bandReference(selector: BandSelector): string {
	switch (selector.by) {
		case 'WAGE':
			return `${selector.from} – ${selector.to ?? '∞'}`;
		case 'WAGE_AND_AGE':
			return `${selector.from} – ${selector.to ?? '∞'} · age ${selector.age_from}–${selector.age_to ?? '∞'}`;
		case 'WAGE_AND_MARITAL':
			return `${selector.from} – ${selector.to ?? '∞'} · ${selector.marital.toLowerCase()}`;
		case 'HEADCOUNT':
			return `headcount ${selector.from} – ${selector.to ?? '∞'}`;
		case 'RISK_CLASS':
			return `risk ${selector.class}`;
	}
	throw new Error(`Unsupported band selector: ${Reflect.get(selector, 'by')}`);
}

/**
 * Pick the one band that governs. `rates` is expected in ascending-ceiling order, which
 * `pickConfiguration` guarantees.
 */
export function selectBand(
	rates: readonly ContributionRate[],
	context: BandContext,
	contributionCode: string
): ResolvedBand {
	const candidates = rates
		.map((rate) => resolveBand(rate, contributionCode))
		.filter((band) => dimensionsMatch(band.selector, context));
	if (candidates.length === 0)
		throw new Error(
			`${contributionCode} has no band for a base of ${context.base}` +
				`${context.age == null ? '' : ` at age ${context.age}`}. ` +
				'Every combination a payroll can present must be banded.'
		);
	const matched = candidates.find((band) => context.base <= bandCeiling(band.selector));
	if (!matched) {
		const highest = candidates[candidates.length - 1];
		throw new Error(
			`${contributionCode} has no band covering a base of ${context.base}: the highest band ends ` +
				`at ${highest == null ? 'nothing' : bandCeiling(highest.selector)}. A ceiling is an ` +
				'open-ended terminal band, not the absence of one.'
		);
	}
	return matched;
}
