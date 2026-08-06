/**
 * Statutory overtime coverage — who the overtime ladder applies to.
 *
 * This is the *entitlement* test, not the *pricing* test: `overtime_rules` says what an overtime
 * hour is worth, and this says whether the person earning it is inside the statute at all. It is
 * kept apart from pricing because it turns on the person (their wage, their work category), not on
 * the day or the hour.
 *
 * Everything here is pure and reads a resolved `overtime_coverage_rules` row, or classifies a pay
 * component against the statute's own definition of wages for the ceiling's comparand. Nothing is
 * hard-coded to a jurisdiction. The literals this replaced were a Malaysian First Schedule test
 * written into the engine, which meant an amendment silently repriced history, no run recorded
 * which threshold priced it, and every non-Malaysian jurisdiction got a confidently wrong "not
 * covered" instead of an absent answer.
 */

export type WageBasis = 'STATUTORY_WAGES' | 'BASE_SALARY';
export type CategoryBasis = 'STATUTORY_WORK_CATEGORY' | 'WORK_CLASSIFICATION';

export type Money = { readonly value: number; readonly currency: string };

/**
 * One pay component classified against the statutory definition of "wages".
 *
 * This is the classification the coverage ceiling's comparand is built from. Employment Act 1955
 * s.2 defines wages as basic wages **and all other cash payments for work done**, and First
 * Schedule para 3 then reads "wages" for the Schedule as that figure less commissions, subsistence
 * allowance and overtime payment. The categories below are that definition, expressed over what a
 * pay component row can say:
 *
 * - `BASIC_WAGES`   — the contracted wage from `employment_terms` (source `SCHEDULE`).
 * - `CASH_FOR_WORK` — an `EARNING` component: any other cash payment for work done.
 * - `OVERTIME_PAY`  — a component the engine prices from the overtime ladder (sources `OVERTIME`
 *                     and `OVERTIME_EXCESS`). Para 3 names this exclusion in terms.
 * - `NOT_WAGES`     — everything else: information, deductions, absences, employer costs, and
 *                     `NON_WAGE_PAYMENT` reimbursements, none of which is a cash payment for work.
 *
 * Two para 3 exclusions the component model cannot express: **commissions and subsistence
 * allowance have no category of their own.** Nothing on `pay_components.policy` or
 * `pay_components.definition` distinguishes a commission from any other earning, so a commission
 * paid through an `EARNING` component is counted in the comparand even though the statute takes it
 * out. The seeded catalogues contain no commission or subsistence component, so no shipped
 * population is affected by the gap — but a company that adds one must know the comparand will
 * overstate until the model carries the distinction.
 */
export type WageComparandCategory = 'BASIC_WAGES' | 'CASH_FOR_WORK' | 'OVERTIME_PAY' | 'NOT_WAGES';

export type WageComparandComponent = {
	readonly policy: { readonly kind: string } | null;
	readonly definition: { readonly source: string } | null;
};

/** Classify one pay component for the wage comparand. See `WageComparandCategory`. */
export function classifyWageComparand(component: WageComparandComponent): WageComparandCategory {
	const source = component.definition?.source;
	if (source === 'OVERTIME' || source === 'OVERTIME_EXCESS') return 'OVERTIME_PAY';
	if (source === 'SCHEDULE') return 'BASIC_WAGES';
	if (component.policy?.kind === 'EARNING') return 'CASH_FOR_WORK';
	return 'NOT_WAGES';
}

/**
 * The s.2 comparand: basic wages plus every other cash payment for work done, less overtime pay.
 *
 * The amounts passed in are the signed entry totals settling in this run for each component — the
 * contractual monthly figures, **not** prorated amounts. The ceiling asks what a person's wages
 * *are* a month, not what a partial month happened to pay: a joiner on RM5,000 earns RM5,000 a
 * month from the day they join, and prorating the comparand would cover them for one month and
 * uncover them the next.
 *
 * `FORMULA` earnings are not counted: their amounts exist only once the component walk has run,
 * which happens after this test has decided who the walk prices overtime for. The under-inclusion
 * keeps an employee inside the ladder rather than outside it, which is the direction the statute
 * reads when doubtful. No seeded company carries a formula earning that a coverage ceiling tests.
 */
export function deriveStatutoryWages(options: {
	readonly baseSalary: Money;
	readonly payments: readonly {
		readonly category: WageComparandCategory;
		readonly amount: number;
	}[];
}): Money {
	const cashForWork = options.payments
		.filter((payment) => payment.category === 'CASH_FOR_WORK')
		.reduce((total, payment) => total + payment.amount, 0);
	return {
		value: options.baseSalary.value + cashForWork,
		currency: options.baseSalary.currency
	};
}

/**
 * The subset of an `overtime_coverage_rules` row the test actually reads.
 *
 * `wage_basis` and `category_basis` are `string`, not their enums, because that is how an enum
 * column arrives from the database — and a row written under an older definition can legitimately
 * carry a value this build has never heard of. Narrowing happens below, where an unrecognised value
 * is a named fault rather than a silent fallthrough to whichever arm the comparison happened to miss.
 */
export type CoverageRule = {
	readonly wage_ceiling: Money | null;
	readonly ceiling_is_inclusive: boolean | null;
	readonly wage_basis: string | null;
	readonly category_basis: string | null;
	readonly exempt_categories: readonly string[] | null;
	readonly excluded_categories: readonly string[] | null;
	readonly authority: string;
};

const WAGE_BASES: readonly WageBasis[] = ['STATUTORY_WAGES', 'BASE_SALARY'];
const CATEGORY_BASES: readonly CategoryBasis[] = ['STATUTORY_WORK_CATEGORY', 'WORK_CLASSIFICATION'];

export type CoverageSubject = {
	readonly statutoryWorkCategory: string | null;
	readonly workClassification: string | null;
	/**
	 * The wage figures the caller was able to resolve, each filed under the basis it genuinely is.
	 *
	 * A caller must never file a base-salary number under `STATUTORY_WAGES` to make a rule evaluate.
	 * Statutory wages are normally wider than basic pay, so the substitution moves the boundary and
	 * changes who is covered — see `UNDETERMINED` below, which exists precisely so that this is
	 * reported rather than papered over.
	 */
	readonly wages: Partial<Record<WageBasis, Money>>;
};

export type CoverageDecision =
	| {
			readonly outcome: 'COVERED';
			readonly reason: 'NO_RULE' | 'EXEMPT_CATEGORY' | 'NO_WAGE_CEILING' | 'WITHIN_CEILING';
	  }
	| { readonly outcome: 'NOT_COVERED'; readonly reason: 'EXCLUDED_CATEGORY' | 'ABOVE_CEILING' }
	| {
			readonly outcome: 'UNDETERMINED';
			readonly reason: 'WAGE_BASIS_UNAVAILABLE' | 'CEILING_CURRENCY_MISMATCH';
			readonly requiredBasis: WageBasis;
	  };

/**
 * The one coverage rule effective for a jurisdiction, or null when none is.
 *
 * Null is a real answer and means universal coverage: a jurisdiction that imposes no coverage
 * restriction is not a jurisdiction where nobody is covered.
 */
export function coverageRuleFor<T extends CoverageRule>(rules: readonly T[]): T | null {
	if (rules.length > 1)
		throw new Error('More than one overtime coverage rule is effective for this jurisdiction.');
	return rules[0] ?? null;
}

function categoryOf(rule: CoverageRule, subject: CoverageSubject): string | null {
	const basis = CATEGORY_BASES.find((candidate) => candidate === rule.category_basis);
	if (basis == null)
		throw new Error(
			`Overtime coverage rule "${rule.authority}" names categories from ` +
				`"${rule.category_basis ?? 'nothing'}", which is not an employment column this engine reads.`
		);
	return basis === 'STATUTORY_WORK_CATEGORY'
		? subject.statutoryWorkCategory
		: subject.workClassification;
}

/**
 * Decide whether the statutory overtime ladder covers one person.
 *
 * Order matters and is not arbitrary. A statute that disapplies a whole Part to a class of worker
 * outranks any wage test, so exclusions are read first; category exemptions are read next because
 * they are written "irrespective of the amount of wages he earns"; only then does the ceiling apply.
 */
export function decideOvertimeCoverage(
	rule: CoverageRule | null,
	subject: CoverageSubject
): CoverageDecision {
	if (rule == null) return { outcome: 'COVERED', reason: 'NO_RULE' };

	const category = categoryOf(rule, subject);
	if (category != null && (rule.excluded_categories ?? []).includes(category))
		return { outcome: 'NOT_COVERED', reason: 'EXCLUDED_CATEGORY' };
	if (category != null && (rule.exempt_categories ?? []).includes(category))
		return { outcome: 'COVERED', reason: 'EXEMPT_CATEGORY' };

	const ceiling = rule.wage_ceiling;
	if (ceiling == null) return { outcome: 'COVERED', reason: 'NO_WAGE_CEILING' };

	// A ceiling with no basis or no inclusivity is unusable, not merely incomplete: there is no
	// defensible default for either, so guessing one would decide pay from a coin toss.
	const basis = WAGE_BASES.find((candidate) => candidate === rule.wage_basis);
	if (basis == null)
		throw new Error(
			`Overtime coverage rule "${rule.authority}" sets a wage ceiling but names no wage basis this ` +
				`engine reads (got "${rule.wage_basis ?? 'nothing'}"), so there is no figure to compare it against.`
		);
	if (rule.ceiling_is_inclusive == null)
		throw new Error(
			`Overtime coverage rule "${rule.authority}" sets a wage ceiling but does not say whether ` +
				'the ceiling amount itself is covered.'
		);

	const wages = subject.wages[basis];
	// The engine could not produce the figure the statute names. Reporting that is the whole point:
	// comparing the nearest available column instead would move the boundary silently.
	if (wages == null)
		return {
			outcome: 'UNDETERMINED',
			reason: 'WAGE_BASIS_UNAVAILABLE',
			requiredBasis: basis
		};
	if (wages.currency !== ceiling.currency)
		return {
			outcome: 'UNDETERMINED',
			reason: 'CEILING_CURRENCY_MISMATCH',
			requiredBasis: basis
		};

	const within = rule.ceiling_is_inclusive
		? wages.value <= ceiling.value
		: wages.value < ceiling.value;
	return within
		? { outcome: 'COVERED', reason: 'WITHIN_CEILING' }
		: { outcome: 'NOT_COVERED', reason: 'ABOVE_CEILING' };
}
