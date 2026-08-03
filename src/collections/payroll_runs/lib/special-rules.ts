/**
 * `statutory_contributions.special_rules` — the closed token set.
 *
 * A statutory scheme is more than a band table. EPF brackets its wage before applying a percentage;
 * PCB annualises, relieves, scales, spreads and rounds twice; SOCSO does none of it. Those
 * behaviours are named rules on the contribution row, so a jurisdiction is still rows rather than
 * code, and a pay component policy's `SPECIAL { rule }` treatment can name one of them.
 *
 * A token is `NAME` or `NAME:arg[:arg]`. **The set is closed**: an unrecognised token is an error,
 * not a no-op, because a silently ignored rule is an under-contribution nobody notices. Validation
 * (chapter 12) reports them before a run starts.
 *
 * | token                        | meaning                                                            |
 * | ---------------------------- | ------------------------------------------------------------------ |
 * | `BRACKET_STEP:<upTo>:<step>` | round the base up to the next `step` while it is ≤ `upTo`          |
 * | `PERSONAL_RELIEF:<amount>`   | annual relief every taxpayer gets                                  |
 * | `SPOUSE_RELIEF:<amount>`     | annual relief when the employee is married                         |
 * | `CHILD_RELIEF:<amount>`      | annual relief per dependent                                        |
 * | `RELIEF_CAP:<amount>`        | on the *relieving* scheme: annual ceiling on its employee share    |
 * | `RELIEF_POOL:<name>`         | schemes sharing one ceiling (SOCSO and EIS share 350)              |
 * | `RELIEF_PROJECTED`           | project this month's share across the periods still to run         |
 * | `MIN_WITHHOLD:<amount>`      | withhold nothing when the regular part falls below this            |
 * | `ROUND:<method>`             | rounding chain, applied in order, overriding `rounding`            |
 * | `TOTAL_ROUNDED_TO_DOLLAR_EMPLOYEE_FLOORED` | round a paired total, floor employee, give remainder to employer |
 * | `ADDITIONAL_REMUNERATION`    | the channel a `SPECIAL` grid cell posts a bonus into               |
 * | `PERIODIC_PROGRESSIVE`       | apply a period table directly; do not annualise or spread          |
 *
 * Reliefs and caps are annual amounts because that is how every tax authority states them. The
 * numbers live on a row; nothing here is a magic constant.
 */

import type { RoundingMethod } from './rounding.js';

export const ADDITIONAL_REMUNERATION = 'ADDITIONAL_REMUNERATION';

const ROUNDING_METHODS = new Set<string>([
	'NONE',
	'NEAREST_CENT',
	'NEAREST_5_CENTS',
	'TRUNCATE_CENT',
	'UP_5_CENTS',
	'NEAREST_UNIT',
	'FLOOR_UNIT',
	'UP_TO_UNIT',
	'TABLE'
]);

/** One rung of a wage-bracket ladder: while the wage is ≤ `upTo`, round it up to the next `step`. */
export type BracketStep = { readonly upTo: number; readonly step: number };

export type SpecialRules = {
	/** Ascending by ceiling. Empty means the base is used exactly as accumulated. */
	readonly bracketSteps: readonly BracketStep[];
	readonly personalRelief: number;
	readonly spouseRelief: number;
	readonly childRelief: number;
	/** Annual ceiling on this scheme's employee share when it is a relief inside another. */
	readonly reliefCap: number | null;
	/** Schemes naming the same pool share one `reliefCap`. */
	readonly reliefPool: string | null;
	/** Whether the relief includes the months still to run, not just the year so far. */
	readonly reliefProjected: boolean;
	/** Suppress the regular withholding below this, per period. */
	readonly minWithhold: number;
	/** Applied in declaration order; empty means fall back to `statutory_contributions.rounding`. */
	readonly roundingChain: readonly RoundingMethod[];
	/** CPF-style paired-share rounding: round the total, floor employee, assign the remainder. */
	readonly totalRoundedEmployeeFloored: boolean;
	readonly additionalRemuneration: boolean;
	readonly periodicProgressive: boolean;
};

const EMPTY: SpecialRules = {
	bracketSteps: [],
	personalRelief: 0,
	spouseRelief: 0,
	childRelief: 0,
	reliefCap: null,
	reliefPool: null,
	reliefProjected: false,
	minWithhold: 0,
	roundingChain: [],
	totalRoundedEmployeeFloored: false,
	additionalRemuneration: false,
	periodicProgressive: false
};

function amount(token: string, argument: string | undefined): number {
	const parsed = Number(argument);
	if (!Number.isFinite(parsed)) throw new Error(`Special rule "${token}" needs a numeric amount.`);
	return parsed;
}

/**
 * Parse a contribution's declared rules. Throws on an unknown token, naming it and the scheme, so a
 * typo in a seed surfaces as a blocked run rather than a wrong number.
 */
export function parseSpecialRules(
	rules: readonly string[],
	contributionCode: string
): SpecialRules {
	const bracketSteps: BracketStep[] = [];
	const roundingChain: RoundingMethod[] = [];
	let parsed: SpecialRules = { ...EMPTY };
	for (const token of rules) {
		const [name, first, second] = token.split(':');
		switch (name) {
			case 'BRACKET_STEP':
				bracketSteps.push({ upTo: amount(token, first), step: amount(token, second) });
				break;
			case 'PERSONAL_RELIEF':
				parsed = { ...parsed, personalRelief: amount(token, first) };
				break;
			case 'SPOUSE_RELIEF':
				parsed = { ...parsed, spouseRelief: amount(token, first) };
				break;
			case 'CHILD_RELIEF':
				parsed = { ...parsed, childRelief: amount(token, first) };
				break;
			case 'RELIEF_CAP':
				parsed = { ...parsed, reliefCap: amount(token, first) };
				break;
			case 'RELIEF_POOL':
				if (!first) throw new Error(`Special rule "${token}" needs a pool name.`);
				parsed = { ...parsed, reliefPool: first };
				break;
			case 'RELIEF_PROJECTED':
				parsed = { ...parsed, reliefProjected: true };
				break;
			case 'MIN_WITHHOLD':
				parsed = { ...parsed, minWithhold: amount(token, first) };
				break;
			case 'ROUND':
				if (!first || !ROUNDING_METHODS.has(first))
					throw new Error(`Special rule "${token}" names an unknown rounding method.`);
				roundingChain.push(first as RoundingMethod);
				break;
			case 'TOTAL_ROUNDED_TO_DOLLAR_EMPLOYEE_FLOORED':
				parsed = { ...parsed, totalRoundedEmployeeFloored: true };
				break;
			case ADDITIONAL_REMUNERATION:
				parsed = { ...parsed, additionalRemuneration: true };
				break;
			case 'PERIODIC_PROGRESSIVE':
				parsed = { ...parsed, periodicProgressive: true };
				break;
			default:
				throw new Error(
					`Statutory contribution ${contributionCode} declares an unknown special rule "${token}".`
				);
		}
	}
	return {
		...parsed,
		bracketSteps: bracketSteps.toSorted((left, right) => left.upTo - right.upTo),
		roundingChain
	};
}

/**
 * Apply a wage-bracket ladder — EPF's Third Schedule.
 *
 * The bracket is the **top** of the step the wage falls in: 3,395.34 in a RM20 step brackets to
 * 3,400. Above the last rung the step vanishes and the wage is used exactly; a seeded terminal band
 * of fixed amounts would freeze contributions at the ceiling instead of continuing to scale, which
 * is wrong for every employee above it (decision E2).
 */
export function bracketBase(base: number, steps: readonly BracketStep[]): number {
	for (const rung of steps) {
		if (base <= rung.upTo) return rung.step > 0 ? Math.ceil(base / rung.step) * rung.step : base;
	}
	return base;
}
