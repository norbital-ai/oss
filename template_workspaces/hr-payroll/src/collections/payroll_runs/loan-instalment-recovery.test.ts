// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureEmployment } from './lib/measure.ts';
import { settle } from './lib/settle.ts';
import { entryPayPeriod } from './lib/entries.ts';
import { attendanceWindow, resolveWindow } from './lib/period.ts';
import { PLAIN_CALENDAR } from './lib/settlement.ts';

const JURISDICTION = {
	norbital_id: 'jur-my',
	code: 'MY',
	proration: { by: 'CALENDAR_DAYS' },
	ordinary_rate_divisor: 26,
	ordinary_rate_basis: 'DAYS_PER_MONTH',
	tax_year_start_month: 1,
	effective_range: { start: '2020-01-01', end: null }
};

const COMPANY = {
	norbital_id: 'co-nihon-my',
	name: 'Nihon (MY)',
	jurisdiction_id: 'jur-my',
	pay_cutoff_day: 21,
	pay_day: 25,
	leave_year_start_month: 1,
	overtime_calculation_method: 'STATUTORY_AGGREGATE',
	risk_class: null,
	settlement_policy: null,
	effective_range: { start: '2020-01-01', end: null }
};

const BASIC = {
	norbital_id: 'pc-basic',
	company_id: 'co-nihon-my',
	code: 'BASIC',
	name: 'Basic salary',
	nature: 'EARNING',
	policy: { kind: 'EARNING', settlement: 'ADD', statutory_treatments: [] },
	sequence: 10,
	eligibility: [],
	definition: { source: 'SCHEDULE', unit: 'MONEY', reducible: false },
	effective_range: { start: '2020-01-01', end: null }
};

/** The loan-recovery component the agreement deducts on. */
const LOAN = {
	norbital_id: 'pc-hari-raya-2026',
	company_id: 'co-nihon-my',
	code: 'HARI_RAYA_2026',
	name: 'Loan recovery',
	nature: 'DEDUCTION',
	policy: { kind: 'DEDUCTION', settlement: 'DEDUCT', statutory_treatments: [] },
	sequence: 90,
	eligibility: [],
	definition: {
		source: 'ENTRY',
		unit: 'MONEY',
		evidence: 'NONE',
		cap: null,
		settlement: 'PAYROLL'
	},
	effective_range: { start: '2026-01-01', end: null }
};

function configuration(payComponents = [BASIC, LOAN]) {
	return {
		company: COMPANY,
		jurisdiction: JURISDICTION,
		contributions: [],
		treatments: new Map(),
		payComponents,
		overtimeRules: [],
		overtimeLimits: [],
		shiftById: new Map(),
		holidays: new Map(),
		leaveTypes: [],
		workPatternById: new Map(),
		hash: 'test'
	};
}

/**
 * The agreement in the report: employment NHPMY0290, six monthly instalments from 2026-04-01, the
 * first of which settles in the 2026-04 run.
 */
function instalment(sequence, dueDate, amount) {
	return {
		norbital_id: `entry-${sequence}`,
		employment_id: 'emp-nhpmy0290',
		pay_component_id: LOAN.norbital_id,
		amount,
		quantity: 1,
		event_date: dueDate,
		// exactly what repayment_agreements/+hooks.ts materialises
		pay_period: dueDate.slice(0, 7),
		description: `Hari Raya 2026 (NHPMY0290) · repayment ${sequence}/6`,
		origin: {
			kind: 'LOAN_INSTALMENT',
			agreement_id: 'agr-hari-raya-2026',
			sequence,
			of: 6
		}
	};
}

function bundle(entries, baseSalary = 3000) {
	const terms = {
		norbital_id: 'terms-1',
		employment_id: 'emp-nhpmy0290',
		base_salary: { value: baseSalary, currency: 'MYR' },
		pay_frequency: 'MONTHLY',
		ordinary_hours_per_week: 45,
		working_days_per_week: 6,
		rest_day: 'SUN',
		work_pattern_id: null,
		overtime_eligible: false,
		statutory_work_category: 'NON_MANUAL',
		effective_range: { start: '2020-01-01', end: null }
	};
	return {
		employment: {
			norbital_id: 'emp-nhpmy0290',
			employee_id: 'ee-1',
			employee_number: 'NHPMY0290',
			company_id: 'co-nihon-my',
			hire_date: '2021-06-01',
			exit_date: null,
			department: null,
			payroll_group: null,
			employment_type: 'PERMANENT',
			work_classification: 'NON_MANUAL',
			effective_range: { start: '2021-06-01', end: null }
		},
		employee: { norbital_id: 'ee-1', date_of_birth: '1990-01-01', gender: 'MALE' },
		terms: [terms],
		statutoryFacts: [],
		entries,
		ledger: [],
		timeEntries: [],
		rosterEntries: [],
		agreements: [],
		serviceMonths: 58,
		age: 36,
		employedDays: { start: '2026-04-01', end: '2026-04-30' },
		wageDays: { start: '2026-04-01', end: '2026-04-30' },
		attendance: { start: '2026-03-21', end: '2026-04-20' },
		arrearsFor: null,
		deferral: null,
		extendedLeaveSettlesInOwnMonth: false
	};
}

function measureApril(entries, options = {}) {
	return measureEmployment({
		bundle: bundle(entries, options.baseSalary),
		configuration: configuration(options.payComponents),
		period: '2026-04',
		salary: { start: '2026-04-01', end: '2026-04-30' },
		periodsRemaining: 9,
		headcount: 1,
		policy: PLAIN_CALENDAR
	});
}

test('a 2026-04-01 instalment settles in the 2026-04 run under a cutoff day of 21', () => {
	// Both of the premises hold: the due date is inside the April attendance window, and the
	// materialised pay_period names the April run outright.
	assert.deepEqual(attendanceWindow('2026-04', 21), { start: '2026-03-21', end: '2026-04-20' });
	assert.equal(resolveWindow('2026-04', COMPANY).period, '2026-04');
	assert.equal(entryPayPeriod(instalment(1, '2026-04-01', 167), 21), '2026-04');
});

test('the April run writes a payslip line linked to the April instalment', () => {
	const measured = measureApril([instalment(1, '2026-04-01', 167)]);
	const loanLines = measured.lines.filter((line) => line.payComponent.code === 'HARI_RAYA_2026');

	assert.equal(loanLines.length, 1, 'the instalment must produce exactly one deduction line');
	assert.equal(loanLines[0].amount, 167, 'a loan instalment is never prorated');
	assert.deepEqual(loanLines[0].component, {
		kind: 'COMPONENT_ENTRY_ONCE',
		pay_component_id: LOAN.norbital_id,
		component_entry_id: 'entry-1'
	});
});

test('only the instalment whose pay_period names this run is deducted', () => {
	const schedule = [
		instalment(1, '2026-04-01', 167),
		instalment(2, '2026-05-01', 167),
		instalment(3, '2026-06-01', 167),
		instalment(4, '2026-07-01', 167),
		instalment(5, '2026-08-01', 167),
		instalment(6, '2026-09-01', 165)
	];
	const measured = measureApril(schedule);
	const linked = measured.lines
		.filter((line) => line.payComponent.code === 'HARI_RAYA_2026')
		.map((line) => line.component.component_entry_id);

	assert.deepEqual(linked, ['entry-1']);
});

test('net-pay protection reduces the instalment but still links and still reports it', () => {
	// A salary of 100 cannot absorb a 167 instalment: the guard must take net to zero rather than
	// negative, and the remainder must survive as a reported shortfall.
	const measured = measureApril([instalment(1, '2026-04-01', 167)], { baseSalary: 100 });
	const settlement = settle({ lines: measured.lines, charges: [] });

	assert.equal(settlement.net, 0);
	assert.deepEqual(settlement.shortfalls, [{ payComponentId: LOAN.norbital_id, amount: 67 }]);

	const loanLine = settlement.lines.find((line) => line.payComponent.code === 'HARI_RAYA_2026');
	// The line survives the guard, so PERSIST still writes it and the instalment still resolves to a
	// payslip line — which is why a squeezed net can never present as "Not consumed".
	assert.equal(loanLine.amount, 100);
	assert.equal(loanLine.component.component_entry_id, 'entry-1');
});

test('an ineligible loan component drops the instalment with no line at all', () => {
	// The one measured path that recovers nothing and links nothing. It is silent by design
	// ("an ineligible component produces nothing at all"), so the schedule is the only place an
	// operator can ever see it.
	const ineligible = {
		...LOAN,
		eligibility: [{ field: 'DEPARTMENT', in: ['ENGINEERING'] }]
	};
	const measured = measureApril([instalment(1, '2026-04-01', 167)], {
		payComponents: [BASIC, ineligible]
	});

	assert.equal(
		measured.lines.filter((line) => line.payComponent.code === 'HARI_RAYA_2026').length,
		0
	);
});
