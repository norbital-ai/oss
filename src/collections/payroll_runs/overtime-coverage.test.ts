// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	classifyWageComparand,
	coverageRuleFor,
	decideOvertimeCoverage,
	deriveStatutoryWages
} from './lib/coverage.ts';
import { isStatutoryOvertimePayCovered } from './lib/measure.ts';
import { resolveRestBreakRules } from './lib/rest-breaks.ts';

/**
 * The Malaysian rule as seeded in Core: Employment Act 1955 First Schedule paragraph 1A, as
 * substituted by the Employment (Amendment of First Schedule) Order 2022 [P.U. (A) 262].
 *
 * Every value asserted below is the statute's, not the engine's. Paragraph 1A reads "the person
 * whose wages **exceeds** four thousand ringgit a month", which is why RM4,000 exactly is covered.
 */
const MY_RULE = {
	wage_ceiling: { value: 4000, currency: 'MYR' },
	ceiling_is_inclusive: true,
	wage_basis: 'STATUTORY_WAGES',
	category_basis: 'STATUTORY_WORK_CATEGORY',
	exempt_categories: ['MANUAL_LABOUR', 'MANUAL_LABOUR_SUPERVISOR', 'COMMERCIAL_VEHICLE_OPERATOR'],
	excluded_categories: ['VESSEL_WORK'],
	authority: 'Employment Act 1955 First Schedule para 1A'
};

const wages = (value, currency = 'MYR') => ({ STATUTORY_WAGES: { value, currency } });

const subject = (overrides = {}) => ({
	statutoryWorkCategory: 'NON_MANUAL',
	workClassification: 'EA_COVERED',
	wages: wages(3000),
	...overrides
});

test('no rule at all means universal coverage, not universal exclusion', () => {
	// The literal this replaced answered "not covered" for every jurisdiction that was not Malaysia.
	// Absence of a coverage restriction is the opposite of a restriction that excludes everyone.
	const decision = decideOvertimeCoverage(null, subject({ wages: {} }));
	assert.equal(decision.outcome, 'COVERED');
	assert.equal(decision.reason, 'NO_RULE');
});

test('the ceiling is inclusive: wages exactly at RM4,000 are still covered', () => {
	const decision = decideOvertimeCoverage(MY_RULE, subject({ wages: wages(4000) }));
	assert.equal(decision.outcome, 'COVERED');
	assert.equal(decision.reason, 'WITHIN_CEILING');
});

test('a cent above the ceiling is not covered', () => {
	const decision = decideOvertimeCoverage(MY_RULE, subject({ wages: wages(4000.01) }));
	assert.equal(decision.outcome, 'NOT_COVERED');
	assert.equal(decision.reason, 'ABOVE_CEILING');
});

test('an exclusive ceiling excludes the boundary amount itself', () => {
	const exclusive = { ...MY_RULE, ceiling_is_inclusive: false };
	assert.equal(
		decideOvertimeCoverage(exclusive, subject({ wages: wages(4000) })).outcome,
		'NOT_COVERED'
	);
	assert.equal(
		decideOvertimeCoverage(exclusive, subject({ wages: wages(3999.99) })).outcome,
		'COVERED'
	);
});

test('an exempt category is covered however high the wage — First Schedule para 2', () => {
	for (const category of MY_RULE.exempt_categories) {
		const decision = decideOvertimeCoverage(
			MY_RULE,
			subject({ statutoryWorkCategory: category, wages: wages(50_000) })
		);
		assert.equal(decision.outcome, 'COVERED', category);
		assert.equal(decision.reason, 'EXEMPT_CATEGORY', category);
	}
});

test('an excluded category is not covered however low the wage', () => {
	// Para 2(4) vessel work disapplies Part XII, which is where ss.60, 60A and 60D live, so the
	// entire rest-day / hours-of-work / holiday ladder is out — wage is never reached.
	const decision = decideOvertimeCoverage(
		MY_RULE,
		subject({ statutoryWorkCategory: 'VESSEL_WORK', wages: wages(1000) })
	);
	assert.equal(decision.outcome, 'NOT_COVERED');
	assert.equal(decision.reason, 'EXCLUDED_CATEGORY');
});

test('exclusion outranks exemption when a category somehow appears in both', () => {
	const contradictory = { ...MY_RULE, exempt_categories: ['VESSEL_WORK'] };
	const decision = decideOvertimeCoverage(
		contradictory,
		subject({ statutoryWorkCategory: 'VESSEL_WORK' })
	);
	assert.equal(decision.outcome, 'NOT_COVERED');
});

test('a rule with no ceiling covers by category alone — the Philippine and Indonesian shape', () => {
	const noCeiling = {
		wage_ceiling: null,
		ceiling_is_inclusive: null,
		wage_basis: null,
		category_basis: 'WORK_CLASSIFICATION',
		exempt_categories: [],
		excluded_categories: ['MANAGERIAL'],
		authority: 'Labor Code of the Philippines art.82'
	};
	assert.equal(
		decideOvertimeCoverage(noCeiling, subject({ workClassification: 'EA_COVERED', wages: {} }))
			.reason,
		'NO_WAGE_CEILING'
	);
	assert.equal(
		decideOvertimeCoverage(noCeiling, subject({ workClassification: 'MANAGERIAL', wages: {} }))
			.reason,
		'EXCLUDED_CATEGORY'
	);
});

test('the rule reads the column its category_basis names, not both', () => {
	// The two vocabularies are not 1:1. A rule keyed on work_classification must not be satisfied by
	// a statutory_work_category value that happens to share a spelling, or vice versa.
	const byClassification = { ...MY_RULE, category_basis: 'WORK_CLASSIFICATION' };
	const decision = decideOvertimeCoverage(
		byClassification,
		subject({
			statutoryWorkCategory: 'MANUAL_LABOUR',
			workClassification: 'EA_COVERED',
			wages: wages(50_000)
		})
	);
	assert.equal(decision.outcome, 'NOT_COVERED');
	assert.equal(decision.reason, 'ABOVE_CEILING');
});

test('a missing wage basis is UNDETERMINED, never approximated from another column', () => {
	// The engine holds base salary; the First Schedule para 3 test is on statutory wages. Comparing
	// the one against the other moves the boundary and silently changes who is covered, so the
	// answer is withheld and named instead.
	const decision = decideOvertimeCoverage(
		MY_RULE,
		subject({ wages: { BASE_SALARY: { value: 3800, currency: 'MYR' } } })
	);
	assert.equal(decision.outcome, 'UNDETERMINED');
	assert.equal(decision.reason, 'WAGE_BASIS_UNAVAILABLE');
	assert.equal(decision.requiredBasis, 'STATUTORY_WAGES');
});

test('a category decision is still reached when the wage figure is unavailable', () => {
	// Category is read before the ceiling, so an exempt or excluded person needs no wage at all.
	assert.equal(
		decideOvertimeCoverage(MY_RULE, subject({ statutoryWorkCategory: 'MANUAL_LABOUR', wages: {} }))
			.outcome,
		'COVERED'
	);
	assert.equal(
		decideOvertimeCoverage(MY_RULE, subject({ statutoryWorkCategory: 'VESSEL_WORK', wages: {} }))
			.outcome,
		'NOT_COVERED'
	);
});

test('a ceiling in another currency is UNDETERMINED rather than compared numerically', () => {
	const decision = decideOvertimeCoverage(MY_RULE, subject({ wages: wages(3000, 'SGD') }));
	assert.equal(decision.outcome, 'UNDETERMINED');
	assert.equal(decision.reason, 'CEILING_CURRENCY_MISMATCH');
});

test('a ceiling seeded without a basis or an inclusivity is a loud fault, not a guess', () => {
	assert.throws(
		() => decideOvertimeCoverage({ ...MY_RULE, wage_basis: null }, subject()),
		/names no wage basis/
	);
	assert.throws(
		() => decideOvertimeCoverage({ ...MY_RULE, ceiling_is_inclusive: null }, subject()),
		/whether the ceiling amount itself is covered/
	);
});

test('an unclassified person falls through to the wage test', () => {
	const decision = decideOvertimeCoverage(
		MY_RULE,
		subject({ statutoryWorkCategory: null, wages: wages(3000) })
	);
	assert.equal(decision.outcome, 'COVERED');
	assert.equal(decision.reason, 'WITHIN_CEILING');
});

test('coverageRuleFor returns null for none and refuses two', () => {
	assert.equal(coverageRuleFor([]), null);
	assert.equal(coverageRuleFor([MY_RULE]), MY_RULE);
	assert.throws(() => coverageRuleFor([MY_RULE, MY_RULE]), /More than one overtime coverage rule/);
});

// ── the comparand: s.2 wages, classified from the pay component model ────────────────────────────

const component = (kind, source) => ({
	policy: kind == null ? null : { kind },
	definition: source == null ? null : { source }
});

test('the comparand classification is the statute read against what a component can say', () => {
	// s.2: basic wages AND all other cash payments for work done; para 3 lessens that by overtime
	// payment. The component model names both: the schedule source is the contracted basic wage, an
	// earning is any other cash payment, and the two overtime sources are the pay para 3 takes out.
	assert.equal(classifyWageComparand(component('EARNING', 'SCHEDULE')), 'BASIC_WAGES');
	assert.equal(classifyWageComparand(component('EARNING', 'ENTRY')), 'CASH_FOR_WORK');
	assert.equal(classifyWageComparand(component('EARNING', 'FORMULA')), 'CASH_FOR_WORK');
	assert.equal(classifyWageComparand(component('EARNING', 'OVERTIME')), 'OVERTIME_PAY');
	assert.equal(classifyWageComparand(component('EARNING', 'OVERTIME_EXCESS')), 'OVERTIME_PAY');
	assert.equal(classifyWageComparand(component('NON_WAGE_PAYMENT', 'ENTRY')), 'NOT_WAGES');
	assert.equal(classifyWageComparand(component('DEDUCTION', 'ENTRY')), 'NOT_WAGES');
	assert.equal(classifyWageComparand(component('ABSENCE', 'FORMULA')), 'NOT_WAGES');
	assert.equal(classifyWageComparand(component('INFORMATION', 'FORMULA')), 'NOT_WAGES');
	assert.equal(classifyWageComparand(component('EMPLOYER_COST', 'ENTRY')), 'NOT_WAGES');
});

test('the comparand is basic plus cash-for-work — the basic+allowance case', () => {
	// The live mispricing the old base-salary test carried: RM3,800 basic plus a RM500 fixed
	// allowance is RM4,300 of para 3 wages, outside the ladder — while base salary alone said in.
	const comparand = deriveStatutoryWages({
		baseSalary: { value: 3800, currency: 'MYR' },
		payments: [
			{ category: 'CASH_FOR_WORK', amount: 500 },
			{ category: 'OVERTIME_PAY', amount: 700 },
			{ category: 'NOT_WAGES', amount: 300 }
		]
	});
	assert.deepEqual(comparand, { value: 4300, currency: 'MYR' });

	const decision = decideOvertimeCoverage(
		MY_RULE,
		subject({ wages: { STATUTORY_WAGES: comparand } })
	);
	assert.equal(decision.outcome, 'NOT_COVERED');
	assert.equal(decision.reason, 'ABOVE_CEILING');

	// The same person with no allowance settling this run stays inside.
	const bare = deriveStatutoryWages({
		baseSalary: { value: 3800, currency: 'MYR' },
		payments: [{ category: 'OVERTIME_PAY', amount: 700 }]
	});
	assert.equal(
		decideOvertimeCoverage(MY_RULE, subject({ wages: { STATUTORY_WAGES: bare } })).outcome,
		'COVERED'
	);
});

test('a reversal on an allowance takes its amount back out of the comparand', () => {
	const comparand = deriveStatutoryWages({
		baseSalary: { value: 3800, currency: 'MYR' },
		payments: [
			{ category: 'CASH_FOR_WORK', amount: 500 },
			{ category: 'CASH_FOR_WORK', amount: -500 }
		]
	});
	assert.equal(comparand.value, 3800);
});

// ── the run-level test: covered, refused, and why ────────────────────────────────────────────────

const runCoverage = (overrides = {}) =>
	isStatutoryOvertimePayCovered({
		rule: MY_RULE,
		jurisdictionCode: 'MY',
		wages: {
			BASE_SALARY: { value: 3000, currency: 'MYR' },
			STATUTORY_WAGES: { value: 3000, currency: 'MYR' }
		},
		statutoryWorkCategory: 'NON_MANUAL',
		workClassification: 'EA_COVERED',
		employeeNumber: 'NHPMY0002',
		...overrides
	});

test('the run-level test decides from the derived comparand, inclusive at RM4,000', () => {
	assert.equal(runCoverage(), true);
	assert.equal(
		runCoverage({
			wages: {
				BASE_SALARY: { value: 4000, currency: 'MYR' },
				STATUTORY_WAGES: { value: 4000, currency: 'MYR' }
			}
		}),
		true,
		'wages exactly at the ceiling stay covered — para 1A bites on wages that EXCEED it'
	);
	assert.equal(
		runCoverage({
			wages: {
				BASE_SALARY: { value: 3800, currency: 'MYR' },
				STATUTORY_WAGES: { value: 4300, currency: 'MYR' }
			}
		}),
		false,
		'the allowance, not the base salary, decides the boundary'
	);
});

test('a vessel worker is outside the ladder at a high wage too — para 2(4) disapplies Part XII', () => {
	assert.equal(
		runCoverage({
			statutoryWorkCategory: 'VESSEL_WORK',
			wages: {
				BASE_SALARY: { value: 50000, currency: 'MYR' },
				STATUTORY_WAGES: { value: 50000, currency: 'MYR' }
			}
		}),
		false
	);
});

test('a ceiling the run cannot compare fails the run and names the employee and the authority', () => {
	// There is no warning tier: a ceiling stated in another currency is not approximated, and the
	// refusal says whose run stopped, why, and under which authority.
	assert.throws(
		() =>
			runCoverage({
				rule: { ...MY_RULE, wage_ceiling: { value: 4000, currency: 'SGD' } }
			}),
		(error) => {
			assert.match(error.message, /NHPMY0002/);
			assert.match(error.message, /different currency/);
			assert.match(error.message, /First Schedule para 1A/);
			return true;
		}
	);
});

test('a rule whose wage figure the caller cannot supply fails the run naming the basis', () => {
	assert.throws(
		() => runCoverage({ wages: {} }),
		(error) => {
			assert.match(error.message, /NHPMY0002/);
			assert.match(error.message, /statutory wages/);
			assert.match(error.message, /overtime_eligible/);
			return true;
		}
	);
});

// ── the Philippine and Indonesian shapes: no wage threshold at all ───────────────────────────────

test('the Philippines excludes by category only — art.82 names no wage figure', () => {
	const PH_RULE = {
		wage_ceiling: null,
		ceiling_is_inclusive: null,
		wage_basis: null,
		category_basis: 'WORK_CLASSIFICATION',
		exempt_categories: [],
		excluded_categories: ['MANAGERIAL'],
		authority: 'Labor Code of the Philippines art.82'
	};
	// No wage was ever asked for: an empty wages map is enough to decide.
	assert.equal(
		decideOvertimeCoverage(PH_RULE, subject({ workClassification: 'EA_COVERED', wages: {} }))
			.outcome,
		'COVERED'
	);
	assert.equal(
		decideOvertimeCoverage(PH_RULE, subject({ workClassification: 'MANAGERIAL', wages: {} }))
			.reason,
		'EXCLUDED_CATEGORY'
	);
	assert.equal(
		decideOvertimeCoverage(
			PH_RULE,
			subject({ workClassification: 'MANAGERIAL', wages: wages(200000, 'PHP') })
		).outcome,
		'NOT_COVERED',
		'a managerial employee is excluded whatever the wage'
	);
});

test('Indonesia covers by job group, and the unencodable group keeps everyone covered', () => {
	// PP 35/2021 Pasal 27(1): overtime wages are owed for work beyond the Pasal 21(2) hours. The
	// single exception, Pasal 27(2), is by JOB GROUP — pemikir, perencana, pelaksana dan/atau
	// pengendali jalannya Perusahaan — and is broader than any work_classification member, and
	// conditional on being set out in the contract besides. The seeded row therefore carries no
	// ceiling and no categories, and its authority records the exception it cannot express.
	const ID_RULE = {
		wage_ceiling: null,
		ceiling_is_inclusive: null,
		wage_basis: null,
		category_basis: 'WORK_CLASSIFICATION',
		exempt_categories: [],
		excluded_categories: [],
		authority:
			'Peraturan Pemerintah No. 35 Tahun 2021 Pasal 27(1) — the regulation sets no wage threshold, and its only exception (Pasal 27(2)) is by job group'
	};
	const decision = decideOvertimeCoverage(
		ID_RULE,
		subject({ workClassification: 'MANAGERIAL', wages: {} })
	);
	assert.equal(decision.outcome, 'COVERED');
	assert.equal(decision.reason, 'NO_WAGE_CEILING');
	// A wage is never the test: a figure supplied changes nothing.
	assert.equal(
		decideOvertimeCoverage(
			ID_RULE,
			subject({ workClassification: 'EA_COVERED', wages: wages(50000000, 'IDR') })
		).outcome,
		'COVERED'
	);
});

// ── meal breaks: the figures are rows, never literals ────────────────────────────────────────────

test('the Malaysian break resolves from its row — five hours, thirty minutes, pay unsettled', () => {
	// EA 1955 s.60A(1)(a): no more than five consecutive hours without a period of leisure of not
	// less than thirty minutes. Proviso (i): a break under thirty minutes does not break the
	// continuity. The section says nothing about whether the break is paid, so the row does not.
	const breaks = resolveRestBreakRules([
		{
			after_consecutive_hours: 5,
			minimum_minutes: 30,
			counts_as_worked_time: null,
			applies_when: 'ALWAYS',
			authority: 'Employment Act 1955 s.60A(1)(a)'
		},
		{
			after_consecutive_hours: 8,
			minimum_minutes: 45,
			counts_as_worked_time: null,
			applies_when: 'CONTINUOUS_ATTENDANCE',
			authority: 'Employment Act 1955 s.60A(1) proviso (ii)'
		}
	]);
	assert.deepEqual(breaks.get('ALWAYS'), {
		appliesWhen: 'ALWAYS',
		afterConsecutiveHours: 5,
		minimumMinutes: 30,
		countsAsWorkedTime: null,
		authority: 'Employment Act 1955 s.60A(1)(a)'
	});
	assert.equal(
		breaks.get('CONTINUOUS_ATTENDANCE')?.afterConsecutiveHours,
		8,
		'the proviso (ii) variant coexists — eight consecutive hours, forty-five minutes aggregate'
	);
	assert.equal(breaks.get('OVERTIME'), undefined, 'no row is no break, not a default');
});

test('the Indonesian break keeps the statute s own words — four hours, and not working time', () => {
	// UU 13/2003 Pasal 79(2)(a): rest of at least half an hour after four consecutive hours, and
	// the provision says in terms the rest is not counted as working hours.
	const rule = resolveRestBreakRules([
		{
			after_consecutive_hours: 4,
			minimum_minutes: 30,
			counts_as_worked_time: false,
			applies_when: 'ALWAYS',
			authority: 'UU 13/2003 Pasal 79(2)(a)'
		}
	]).get('ALWAYS');
	assert.equal(rule?.afterConsecutiveHours, 4);
	assert.equal(rule?.countsAsWorkedTime, false, 'false is the statute s words, not a default');
});

test('the Philippine break is tied to meals, not to elapsed hours — the null trigger is the fact', () => {
	const rule = resolveRestBreakRules([
		{
			after_consecutive_hours: null,
			minimum_minutes: 60,
			counts_as_worked_time: null,
			applies_when: 'ALWAYS',
			authority: 'Labor Code of the Philippines art.85'
		}
	]).get('ALWAYS');
	assert.equal(rule?.afterConsecutiveHours, null, 'art.85 states no consecutive-hours trigger');
	assert.equal(rule?.minimumMinutes, 60);
});

test('a second row of the same kind is a seeding fault, and an unknown kind is a named fault', () => {
	const row = (applies_when, authority) => ({
		after_consecutive_hours: 5,
		minimum_minutes: 30,
		counts_as_worked_time: null,
		applies_when,
		authority
	});
	assert.throws(
		() => resolveRestBreakRules([row('ALWAYS', 'one'), row('ALWAYS', 'two')]),
		/More than one ALWAYS rest break rule/
	);
	assert.throws(
		() => resolveRestBreakRules([row('SOMETIMES', 'a mystery')]),
		/not a kind of break/
	);
});
