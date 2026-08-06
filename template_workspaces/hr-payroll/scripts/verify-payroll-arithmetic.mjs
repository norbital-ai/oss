// fallow-ignore-file unused-file -- Standalone arithmetic gate invoked directly from the payroll README.

/**
 * Arithmetic verification for the payroll engine.
 *
 * This workspace has no test runner — there is no `vitest` dependency and no `test` script — so the
 * assertions that would be a `.test.ts` live here instead, as a script that can be run directly:
 *
 * ```
 * cd template_workspaces/hr-payroll
 * node scripts/verify-payroll-arithmetic.mjs
 * ```
 *
 * The engine modules are TypeScript, so they are loaded through Vite's SSR module graph, which
 * resolves the `.js` specifiers TypeScript writes back to their `.ts` sources. Only pure modules
 * are exercised: nothing here touches a database.
 *
 * Every case below is one where the arithmetic is not obvious, and every one of them is a place a
 * plausible-looking reimplementation gets a different number.
 */

import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lib = (name) => `/src/collections/payroll_runs/lib/${name}.ts`;

let passed = 0;
const failures = [];

function check(name, actual, expected) {
	const ok =
		typeof expected === 'number' && typeof actual === 'number'
			? Math.abs(actual - expected) < 1e-9
			: JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) passed += 1;
	else
		failures.push(
			`${name}\n    expected ${JSON.stringify(expected)}\n    received ${JSON.stringify(actual)}`
		);
}

function throws(name, fn) {
	try {
		fn();
		failures.push(`${name}\n    expected a thrown error, received none`);
	} catch {
		passed += 1;
	}
}

const server = await createServer({
	root,
	configFile: false,
	logLevel: 'error',
	server: { middlewareMode: true, hmr: false }
});

const { roundMoney, roundHalfDay, floorHalfHour, cents } = await server.ssrLoadModule(
	lib('rounding')
);
const { selectBand, bandFloor } = await server.ssrLoadModule(lib('bands'));
const { bracketBase, parseSpecialRules } = await server.ssrLoadModule(lib('special-rules'));
const { contribute, scaleProgressive } = await server.ssrLoadModule(lib('contribute'));
const { attendanceWindow, defaultPayPeriod, payPeriodsRemaining, resolveWindow } =
	await server.ssrLoadModule(lib('period'));
const { inclusiveDays } = await server.ssrLoadModule(lib('dates'));
const { accruedDays, unpaidLeaveInWindow } = await server.ssrLoadModule(lib('leave'));
const {
	extendedAbsenceDays,
	inExtendedLeavePopulation,
	overtimeAttendanceWindow,
	readSettlementPolicy,
	resolveEmploymentSettlement,
	PLAIN_CALENDAR
} = await server.ssrLoadModule(lib('settlement'));
const {
	classifyOvertimeByCalendarMonth,
	deriveDailyOvertime,
	philippineNightWorkHours,
	priceDay,
	regulatedMonthlyOvertimeHours
} = await server.ssrLoadModule(lib('overtime'));
const { resolveSchedule } = await server.ssrLoadModule(lib('schedule'));
const { isStatutoryOvertimePayCovered } = await server.ssrLoadModule(lib('measure'));
const { classifyWageComparand, deriveStatutoryWages } = await server.ssrLoadModule(lib('coverage'));
const { resolveRestBreakRules } = await server.ssrLoadModule(lib('rest-breaks'));
const { annualisedContractHourlyRate, ordinaryHourlyRate, ordinaryDayWage, overtimeHourlyRate } =
	await server.ssrLoadModule(lib('ordinary-rate'));
const { entrySign } = await server.ssrLoadModule(lib('entries'));
const { settle } = await server.ssrLoadModule(lib('settle'));

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Rounding — the five methods, including the ties this data is full of.
// ────────────────────────────────────────────────────────────────────────────────────────────────
check('NEAREST_CENT rounds a genuine tie up', roundMoney(81.375, 'NEAREST_CENT'), 81.38);
check('NEAREST_CENT survives float error', roundMoney(0.1 + 0.2, 'NEAREST_CENT'), 0.3);
check('TRUNCATE_CENT rounds toward zero', roundMoney(97.1499, 'TRUNCATE_CENT'), 97.14);
check('UP_5_CENTS always rounds up', roundMoney(97.14, 'UP_5_CENTS'), 97.15);
check('UP_5_CENTS leaves an exact multiple alone', roundMoney(97.15, 'UP_5_CENTS'), 97.15);
check('UP_TO_UNIT is EPF’s next whole ringgit', roundMoney(373.99, 'UP_TO_UNIT'), 374);
check('UP_TO_UNIT leaves a whole unit alone', roundMoney(374, 'UP_TO_UNIT'), 374);
check(
	'TABLE is the identity — a tabled amount is published, not computed',
	roundMoney(81.35, 'TABLE'),
	81.35
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The overtime floor — half an hour down, and no one-hour minimum.
// ────────────────────────────────────────────────────────────────────────────────────────────────
check('3.25 h floors to 3.0', floorHalfHour(3.25), 3);
check('1.9 h floors to 1.5', floorHalfHour(1.9), 1.5);
check('0.4 h floors away entirely — there is no one-hour minimum', floorHalfHour(0.4), 0);
check('2.5 h is already a half hour', floorHalfHour(2.5), 2.5);
/*
 * A rest day worked. This row used to carry `overtime_authorized` and a five-hour approved bucket,
 * and the bucket was taken as the payable duration. Both columns are gone: the clock is the only
 * account of the day there is, so the same row now earns what it was actually at work for.
 */
const restDayPunches = {
	norbital_id: 'rest-day-entry',
	work_date: '2026-01-17',
	clock_in: '2026-01-17T08:29:00.000+08:00',
	clock_out: '2026-01-17T13:41:00.000+08:00',
	break_minutes: 60,
	state: 'CLOSED',
	overtime_in: null,
	overtime_out: null
};
const restDayScheduled = {
	date: '2026-01-17',
	dayType: 'REST_DAY',
	shift: {
		pays_overtime: true,
		break_minutes: 60
	},
	clampStart: '08:30',
	normalHours: 8.5
};
check(
	'a rest day is priced from the clock: 08:30–13:41 less an hour, floored to the half hour',
	deriveDailyOvertime(restDayPunches, restDayScheduled)?.hours,
	4
);
check(
	'a shift that never pays overtime still earns nothing, whatever the clock says',
	deriveDailyOvertime(restDayPunches, {
		...restDayScheduled,
		shift: { ...restDayScheduled.shift, pays_overtime: false }
	}),
	null
);
const semiMonthlyOvertimePolicy = {
	...PLAIN_CALENDAR,
	overtimeWindows: [{ payFrequency: 'SEMI_MONTHLY', startDay: 1, endDay: 15 }]
};
check(
	'semi-monthly OT uses the current month 1st–15th slice',
	overtimeAttendanceWindow({
		policy: semiMonthlyOvertimePolicy,
		payFrequency: 'SEMI_MONTHLY',
		salary: { start: '2026-01-01', end: '2026-01-31' },
		fallback: { start: '2025-12-21', end: '2026-01-20' }
	}),
	{ start: '2026-01-01', end: '2026-01-15' }
);
check(
	'monthly OT keeps the company 21st–20th window',
	overtimeAttendanceWindow({
		policy: semiMonthlyOvertimePolicy,
		payFrequency: 'MONTHLY',
		salary: { start: '2026-01-01', end: '2026-01-31' },
		fallback: { start: '2025-12-21', end: '2026-01-20' }
	}),
	{ start: '2025-12-21', end: '2026-01-20' }
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Entry settlement — a panel-clinic invoice is a company cost, not cash paid to the employee.
// ────────────────────────────────────────────────────────────────────────────────────────────────
// A `MeasuredLine` carries the `pay_components` row itself: `code`, `nature` and `sequence` are
// columns on that row — `nature` is generated from `policy ->> 'kind'` — and there is deliberately
// no component-types lookup table to hold them separately.
const claimLine = (settlement, amount) => ({
	payComponent: {
		norbital_id: `claim-${settlement}`,
		code: 'REIMBURSEMENT',
		nature: 'NON_WAGE_PAYMENT',
		sequence: 1500,
		definition: {
			source: 'ENTRY',
			unit: 'MONEY',
			evidence: 'REQUIRED',
			cap: null,
			settlement
		}
	},
	component: {
		kind: 'COMPONENT_ENTRY_ONCE',
		pay_component_id: `claim-${settlement}`,
		component_entry_id: `entry-${settlement}`
	},
	amount,
	quantity: null,
	rate: null,
	sequence: 1
});
const claimSettlement = settle({
	lines: [claimLine('PAYROLL', 100), claimLine('COMPANY_DIRECT', 75)],
	charges: []
});
check('a payroll-settled claim reaches employee net', claimSettlement.net, 100);
check('a company-direct claim is an employer cost', claimSettlement.employerCost, 75);
check('both claim lines remain available for audit', claimSettlement.lines.length, 2);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Leave accrual — the running total is rounded, never the increment.
// ────────────────────────────────────────────────────────────────────────────────────────────────
check('round_half is half-up at the quarter', roundHalfDay(5.25), 5.5);
check('round_half leaves a half alone', roundHalfDay(5.5), 5.5);
check('round_half rounds 1.75 to 2.0', roundHalfDay(1.75), 2);

const annualLeave = {
	code: 'ANNUAL',
	norbital_id: 'leave-annual',
	accrual: { kind: 'MONTHLY', carry: { limit_days: 6, expiry_months: 3 } }
};
const accrue = (asOf, entitlement = () => 21) =>
	accruedDays({
		leaveType: annualLeave,
		entitlementAtMonths: entitlement,
		hireDate: '2020-01-01',
		exitDate: null,
		leaveYearStart: '2026-01-01',
		asOf
	});
check('21 days accrue to 2.0 by 31 January', accrue('2026-01-31'), 2);
check('21 days accrue to 3.5 by 28 February', accrue('2026-02-28'), 3.5);
check('21 days accrue to 5.5 by 31 March', accrue('2026-03-31'), 5.5);
check('21 days accrue to 14.0 by 31 August', accrue('2026-08-31'), 14);
check('21 days land exactly on the entitlement in December', accrue('2026-12-31'), 21);
// Rounding each month instead would give 12 × 2.0 = 24.0 — three days too many.
check(
	'the band is read at each month, so a mid-year crossing accrues at both rates',
	accrue('2026-12-31', (months) => (months < 78 ? 12 : 16)),
	14
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// EPF — the Third Schedule bracket is the top of the step the wage falls in.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const epfSteps = [
	{ upTo: 5000, step: 20 },
	{ upTo: 20000, step: 100 }
];
check('3,395.34 brackets up to 3,400', bracketBase(3395.34, epfSteps), 3400);
check('a wage already on a step boundary stays put', bracketBase(3400, epfSteps), 3400);
check(
	'4,995 brackets to 5,000 while still below the rate switch',
	bracketBase(4995, epfSteps),
	5000
);
check('above 5,000 the step is RM100', bracketBase(7350.01, epfSteps), 7400);
check(
	'above 20,000 the step vanishes and the wage is exact',
	bracketBase(25123.45, epfSteps),
	25123.45
);
check('the verified EPF employee share', roundMoney(3400 * 0.11, 'UP_TO_UNIT'), 374);
check('the verified EPF employer share', roundMoney(3400 * 0.13, 'UP_TO_UNIT'), 442);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Band selection — by ceiling, and never by silent fallback.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const socsoBands = [
	{
		selector: { by: 'WAGE', from: 4600, to: 4700 },
		award: { kind: 'FIXED', employee: 23.25, employer: 81.35 }
	},
	{
		selector: { by: 'WAGE', from: 4700, to: 4800 },
		award: { kind: 'FIXED', employee: 23.75, employer: 83.15 }
	},
	{
		selector: { by: 'WAGE', from: 4800, to: null },
		award: { kind: 'FIXED', employee: 24.25, employer: 84.95 }
	}
];
const context = { base: 0, age: 33, headcount: 90, riskClass: null };
check(
	'4,788.45 selects the band ENDING at 4,800 — not the one starting there',
	selectBand(socsoBands, { ...context, base: 4788.45 }, 'SOCSO').award.employee,
	23.75
);
check(
	'a wage exactly on a boundary belongs to the band it ends',
	selectBand(socsoBands, { ...context, base: 4700 }, 'SOCSO').award.employee,
	23.25
);
check(
	'the open-ended terminal band is the ceiling',
	selectBand(socsoBands, { ...context, base: 12000 }, 'SOCSO').award.employer,
	84.95
);
throws('no band at all is an error, not a fallback to the last row', () =>
	selectBand(
		[
			{
				selector: { by: 'WAGE', from: 0, to: 100 },
				award: { kind: 'FIXED', employee: 1, employer: 2 }
			}
		],
		{ ...context, base: 5000 },
		'SOCSO'
	)
);

const agedBands = [
	{
		selector: { by: 'WAGE_AND_AGE', from: 0, to: null, age_from: 0, age_to: 60 },
		award: { kind: 'PERCENT', employee: 11, employer: 13 }
	},
	{
		selector: { by: 'WAGE_AND_AGE', from: 0, to: null, age_from: 60, age_to: null },
		award: { kind: 'PERCENT', employee: 0, employer: 4 }
	}
];
check(
	'age filters before the wage ceiling picks',
	selectBand(agedBands, { ...context, base: 3400, age: 61 }, 'EPF').award.employee,
	0
);
check(
	'and the under-60 class still reads its own row',
	selectBand(agedBands, { ...context, base: 3400, age: 59 }, 'EPF').award.employee,
	11
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// PCB — PROGRESSIVE is cumulative. This is the single most expensive detail in the engine.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const pcbBands = [
	{
		selector: { by: 'WAGE', from: 0, to: 5000 },
		award: { kind: 'PROGRESSIVE', rate: 0, constant: 0 }
	},
	{
		selector: { by: 'WAGE', from: 5000, to: 20000 },
		award: { kind: 'PROGRESSIVE', rate: 1, constant: -400 }
	},
	{
		selector: { by: 'WAGE', from: 20000, to: 35000 },
		award: { kind: 'PROGRESSIVE', rate: 3, constant: -250 }
	},
	{
		selector: { by: 'WAGE', from: 35000, to: 50000 },
		award: { kind: 'PROGRESSIVE', rate: 6, constant: 600 }
	},
	{
		selector: { by: 'WAGE', from: 50000, to: 70000 },
		award: { kind: 'PROGRESSIVE', rate: 11, constant: 1500 }
	},
	{
		selector: { by: 'WAGE', from: 70000, to: null },
		award: { kind: 'PROGRESSIVE', rate: 19, constant: 3700 }
	}
];
const pcb = { row: { code: 'PCB', norbital_id: 'pcb' }, rates: pcbBands };
check(
	'chargeable 44,111.40 taxes at 600 + 9,111.40 × 6% = 1,146.68',
	Number(scaleProgressive(pcb, 44111.4, context).toFixed(2)),
	1146.68
);
// The flat-addend misreading would give 0.06 × 44,111.40 + 600 = 3,246.68 — 175.00 per month wrong.
check(
	'and it is decidedly not the flat-addend reading',
	scaleProgressive(pcb, 44111.4, context) === 3246.68,
	false
);
check('the band floor is what the slice is measured from', bandFloor(pcbBands[3].selector), 35000);
check(
	'a chargeable income inside the zero band pays nothing',
	scaleProgressive(pcb, 4000, context),
	0
);
check(
	'the error grows with income: 1,500,000 is 3,700 + 1,430,000 × 19%',
	scaleProgressive(pcb, 1500000, context),
	3700 + 1430000 * 0.19
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The relief pools are asymmetric on purpose: one projects, one does not.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const epfRules = parseSpecialRules(
	['RELIEF_CAP:4000', 'RELIEF_PROJECTED', 'BRACKET_STEP:5000:20', 'ROUND:UP_TO_UNIT'],
	'EPF'
);
check('the bracket ladder parses in ascending order', epfRules.bracketSteps, [
	{ upTo: 5000, step: 20 }
]);
check('the relief cap is read off the row', epfRules.reliefCap, 4000);
check('projection is opt-in', epfRules.reliefProjected, true);
check(
	'the rounding chain is ordered',
	parseSpecialRules(['ROUND:TRUNCATE_CENT', 'ROUND:UP_5_CENTS'], 'PCB').roundingChain,
	['TRUNCATE_CENT', 'UP_5_CENTS']
);
check(
	'a pooled cap names its pool',
	parseSpecialRules(['RELIEF_POOL:SOCSO_EIS', 'RELIEF_CAP:350'], 'EIS').reliefPool,
	'SOCSO_EIS'
);
check(
	'a period progressive table explicitly opts out of annualisation',
	parseSpecialRules(['PERIODIC_PROGRESSIVE'], 'WTAX').periodicProgressive,
	true
);
throws('an unknown special rule is an error, never a silent no-op', () =>
	parseSpecialRules(['MAKE_IT_CHEAPER:1'], 'EPF')
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The whole CONTRIBUTE step, on the verified employee: basic 3,451, NPL 55.66, overtime 365.44.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const epfContribution = {
	row: {
		norbital_id: 'epf',
		code: 'EPF',
		sequence: 10,
		rounding: 'UP_TO_UNIT',
		special_rules: [
			'BRACKET_STEP:5000:20',
			'BRACKET_STEP:20000:100',
			'RELIEF_CAP:4000',
			'RELIEF_PROJECTED'
		],
		relief_for: ['pcb']
	},
	rates: [
		{
			selector: { by: 'WAGE_AND_AGE', from: 0, to: 5000, age_from: 0, age_to: 60 },
			award: { kind: 'PERCENT', employee: 11, employer: 13 }
		},
		{
			selector: { by: 'WAGE_AND_AGE', from: 5000, to: null, age_from: 0, age_to: 60 },
			award: { kind: 'PERCENT', employee: 11, employer: 12 }
		}
	]
};
const socsoContribution = {
	row: {
		norbital_id: 'socso',
		code: 'SOCSO',
		sequence: 20,
		rounding: 'TABLE',
		special_rules: ['RELIEF_POOL:SOCSO_EIS', 'RELIEF_CAP:350'],
		relief_for: ['pcb']
	},
	rates: [
		{
			selector: { by: 'WAGE', from: 3700, to: 3800 },
			award: { kind: 'FIXED', employee: 18.75, employer: 65.65 }
		},
		{
			selector: { by: 'WAGE', from: 3800, to: null },
			award: { kind: 'FIXED', employee: 19.25, employer: 67.45 }
		}
	]
};
const eisContribution = {
	row: {
		norbital_id: 'eis',
		code: 'EIS',
		sequence: 30,
		rounding: 'TABLE',
		special_rules: ['RELIEF_POOL:SOCSO_EIS', 'RELIEF_CAP:350'],
		relief_for: ['pcb']
	},
	rates: [
		{
			selector: { by: 'WAGE', from: 3700, to: 3800 },
			award: { kind: 'FIXED', employee: 7.5, employer: 7.5 }
		},
		{
			selector: { by: 'WAGE', from: 3800, to: null },
			award: { kind: 'FIXED', employee: 7.7, employer: 7.7 }
		}
	]
};
const charges = contribute({
	bases: [
		{ contribution: epfContribution, base: 3395.34, special: {} },
		{ contribution: socsoContribution, base: 3760.78, special: {} },
		{ contribution: eisContribution, base: 3760.78, special: {} }
	],
	facts: new Map(),
	yearToDate: () => ({ employee: 0, employer: 0, base: 0 }),
	age: 33,
	headcount: 90,
	riskClass: null,
	periodsRemaining: 12,
	spouseIsDependent: false,
	dependents: 0
});
const by = (code) => charges.find((charge) => charge.contribution.row.code === code);
check('EPF employee on a 3,395.34 base is 374', by('EPF').employee, 374);
check('EPF employer on a 3,395.34 base is 442', by('EPF').employer, 442);
check('SOCSO reads its table verbatim: 18.75', by('SOCSO').employee, 18.75);
check('SOCSO employer reads 65.65, not 3,760.78 × 1.75%', by('SOCSO').employer, 65.65);
check('EIS reads 7.50 on both sides', by('EIS').employee, 7.5);
check('the band a figure came from is recorded', by('SOCSO').bandReference, '3700 – 3800');
check(
	'net reconciles: 3,760.78 + 93.50 − (374 + 18.75 + 7.50) = 3,454.03',
	cents(3760.78 + 93.5 - (by('EPF').employee + by('SOCSO').employee + by('EIS').employee)),
	3454.03
);

const unregistered = contribute({
	bases: [{ contribution: epfContribution, base: 3395.34, special: {} }],
	facts: new Map([['epf', { kind: 'NOT_REGISTERED', rate_override: null }]]),
	yearToDate: () => ({ employee: 0, employer: 0, base: 0 }),
	age: 33,
	headcount: 90,
	riskClass: null,
	periodsRemaining: 12,
	spouseIsDependent: false,
	dependents: 0
});
check('an unregistered employment contributes nothing', unregistered[0].employee, 0);

const periodicTax = contribute({
	bases: [
		{
			contribution: {
				row: {
					norbital_id: 'period-relief',
					code: 'PERIOD_RELIEF',
					sequence: 100,
					rounding: 'NONE',
					special_rules: [],
					relief_for: ['period-tax']
				},
				rates: [
					{
						selector: { by: 'WAGE', from: 0, to: null },
						award: { kind: 'FIXED', employee: 2750, employer: 0 }
					}
				]
			},
			base: 34700,
			special: {}
		},
		{
			contribution: {
				row: {
					norbital_id: 'period-tax',
					code: 'PERIOD_TAX',
					sequence: 400,
					rounding: 'NEAREST_CENT',
					special_rules: ['PERIODIC_PROGRESSIVE'],
					relief_for: []
				},
				rates: [
					{
						selector: { by: 'WAGE', from: 0, to: 20833 },
						award: { kind: 'PROGRESSIVE', rate: 0, constant: 0 }
					},
					{
						selector: { by: 'WAGE', from: 20833, to: null },
						award: { kind: 'PROGRESSIVE', rate: 15, constant: 0 }
					}
				]
			},
			base: 34700,
			special: {}
		}
	],
	facts: new Map(),
	yearToDate: () => ({ employee: 9999, employer: 0, base: 999999 }),
	age: 33,
	headcount: 20,
	riskClass: null,
	periodsRemaining: 12,
	spouseIsDependent: false,
	dependents: 0
});
check(
	'periodic tax excludes rice and current mandatory relief without YTD projection',
	periodicTax.find((charge) => charge.contribution.row.code === 'PERIOD_TAX').employee,
	1667.55
);

const nonResidentPcb = contribute({
	bases: [
		{
			contribution: {
				row: {
					norbital_id: 'pcb',
					code: 'PCB',
					sequence: 400,
					rounding: 'NONE',
					special_rules: [
						'PERSONAL_RELIEF:9000',
						'MIN_WITHHOLD:10',
						'ROUND:TRUNCATE_CENT',
						'ROUND:UP_5_CENTS'
					],
					relief_for: []
				},
				rates: pcbBands
			},
			base: 7419.35,
			special: {}
		}
	],
	facts: new Map([
		['pcb', { kind: 'REGISTERED', reference_number: 'IG29988009050', rate_override: 30 }]
	]),
	yearToDate: () => ({ employee: 0, employer: 0, base: 0 }),
	age: 59,
	headcount: 90,
	riskClass: null,
	periodsRemaining: 10,
	spouseIsDependent: false,
	dependents: 0
});
check(
	'a progressive-scheme override is a flat current-remuneration award with no resident relief',
	nonResidentPcb[0].employee,
	2225.8
);
check(
	'the flat override records no resident progressive band',
	nonResidentPcb[0].bandReference,
	null
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The attendance window — off by one at both ends is off by ninety attendance days a month.
// ────────────────────────────────────────────────────────────────────────────────────────────────
check('cutoff 21 for 2026-01 runs 21 Dec → 20 Jan', attendanceWindow('2026-01', 21), {
	start: '2025-12-21',
	end: '2026-01-20'
});
check(
	'a cutoff past the end of February clamps rather than wrapping',
	attendanceWindow('2026-03', 31),
	{
		start: '2026-02-28',
		end: '2026-03-30'
	}
);
check(
	'an entry on the cutoff day settles this period',
	defaultPayPeriod('2026-01-21', 21),
	'2026-01'
);
check('an entry after it settles next period', defaultPayPeriod('2026-01-25', 21), '2026-02');
check(
	'twelve periods remain in January of a calendar tax year',
	payPeriodsRemaining('2026-01', 1),
	12
);
check('one remains in December', payPeriodsRemaining('2026-12', 1), 1);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Settlement — which run an employment's money lands in.
//
// Every figure below is the customer's own salary listing, so these are not invented cases: they
// are the rows the workbook already contains, and matching them is the whole test.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const COMPANY_A = { pay_cutoff_day: 21, pay_day: 28 };
const companyAWindow = (period) => resolveWindow(period, COMPANY_A);
const COMPANY_A_POLICY = readSettlementPolicy({
	settlement_policy: {
		late_joiner_arrears: { defer_to_component_id: '00000000-0000-4000-8000-000000000001' },
		final_period: 'SETTLE_IN_FINAL_PERIOD',
		final_period_wages: 'PRORATE_TO_EXIT',
		extended_unpaid_leave: null,
		absence_proration: null,
		overtime_windows: null
	}
});
const COMPANY_B_POLICY = readSettlementPolicy({
	settlement_policy: {
		late_joiner_arrears: null,
		final_period: 'FOLLOW_ATTENDANCE_WINDOW',
		final_period_wages: 'FULL_PERIOD',
		extended_unpaid_leave: null,
		absence_proration: [
			{
				pay_frequency: 'MONTHLY',
				basis: { by: 'FIXED_DAYS', days: 21.75 }
			}
		],
		overtime_windows: null
	}
});
const settle_ = (period, hire, exit, policy = COMPANY_A_POLICY) =>
	resolveEmploymentSettlement({ dates: { hire, exit }, window: companyAWindow(period), policy });

// Twenty-one January UL dates, but only the thirteen through 20 January belong to the
// January payroll. The eight dates from 21–30 January settle in February under the ordinary cutoff.
const january0048UnpaidDates = [
	'2026-01-04',
	'2026-01-05',
	'2026-01-06',
	'2026-01-07',
	'2026-01-08',
	'2026-01-09',
	'2026-01-12',
	'2026-01-13',
	'2026-01-14',
	'2026-01-15',
	'2026-01-16',
	'2026-01-19',
	'2026-01-20',
	'2026-01-21',
	'2026-01-22',
	'2026-01-23',
	'2026-01-26',
	'2026-01-27',
	'2026-01-28',
	'2026-01-29',
	'2026-01-30'
];
const january0048Window = companyAWindow('2026-01').attendance;
const january0048SettledDates = january0048UnpaidDates.filter(
	(date) => date >= january0048Window.start && date <= january0048Window.end
);
check(
	'21 January unpaid-leave dates stop at the 20 January cutoff',
	january0048SettledDates.length,
	13
);
check(
	'13-day January NPL through cutoff reproduces expected amount',
	roundMoney(
		roundMoney(1768 / 31, 'NEAREST_CENT') * january0048SettledDates.length,
		'NEAREST_CENT'
	),
	741.39
);

// ── Rule 1: a joining period the run cannot see is deferred, not part-paid ──────────────────────
//
// A late joiner joined 23 Feb 2026. The February salary listing has no row for them at all, and the
// March one pays basic 4,000 with back-pay basic 857.14 beside it — 4,000 x 6/28, the six days
// 23-28 February. A second case joined 22 April, absent from the April listing,
// and May pays 2,300 with `back_pay_basic` 690 — 2,300 x 9/30.
const feb0397 = settle_('2026-02', '2026-02-23', null);
check('a joiner after the window closes produces no February payslip', feb0397.runs, false);
check('their February is deferred to March', feb0397.deferral?.paidInPeriod, '2026-03');
check('the deferral covers 23-28 February', feb0397.deferral?.days, {
	start: '2026-02-23',
	end: '2026-02-28'
});
check(
	'the workbook’s 857.14 is 4000 x those six days over February',
	roundMoney(4000 * (inclusiveDays('2026-02-23', '2026-02-28') / 28), 'NEAREST_CENT'),
	857.14
);
const mar0397 = settle_('2026-03', '2026-02-23', null);
check('March runs them', mar0397.runs, true);
check('and knows it owes February', mar0397.arrearsFor?.period, '2026-02');
check('March itself is only March', mar0397.employedDays, {
	start: '2026-03-01',
	end: '2026-03-31'
});
// The arrears is measured against February's OWN window, which this employment has no day inside.
// The days they did work — 23 to 28 February — are in the 21 Feb - 20 Mar window this run already
// reads, so their clocks are paid here once, not once here and again inside the back pay. It is
// why every late joiner in the source workbook has an empty `back_pay_ot`.
check('the arrears reads February’s own window', mar0397.arrearsFor?.attendance, {
	start: '2026-01-21',
	end: '2026-02-20'
});
check(
	'which the joiner has no day inside',
	mar0397.arrearsFor.attendance.end < mar0397.arrearsFor.days.start,
	true
);
check('while the tail they worked sits in March’s window', mar0397.attendance, {
	start: '2026-02-21',
	end: '2026-03-20'
});
check('the arrears prorates over February, not March', mar0397.arrearsFor?.salary, {
	start: '2026-02-01',
	end: '2026-02-28'
});
check('and covers exactly the days they were employed then', mar0397.arrearsFor?.days, {
	start: '2026-02-23',
	end: '2026-02-28'
});
check(
	'nothing is owed once the deferred month is behind them',
	settle_('2026-04', '2026-02-23', null).arrearsFor,
	null
);
// Where the two rules meet, the final-pay rule wins: there is no next run to defer into, and
// deferring anyway would strand the wage forever.
const bothRules = settle_('2026-04', '2026-04-22', '2026-04-29');
check('someone who joins and leaves inside one period is not deferred', bothRules.runs, true);
check('their period is settled here', bothRules.deferral, null);
check('over exactly the days they were employed', bothRules.employedDays, {
	start: '2026-04-22',
	end: '2026-04-29'
});
check('with the window extended to cover them', bothRules.attendance, {
	start: '2026-03-21',
	end: '2026-04-29'
});
const apr0400 = settle_('2026-04', '2026-04-22', null);
check('late joiner after window close defers April period', apr0400.runs, false);
check('covering 22-30 April', apr0400.deferral?.days, { start: '2026-04-22', end: '2026-04-30' });
check(
	'which is the workbook’s 690 exactly',
	roundMoney(2300 * (inclusiveDays('2026-04-22', '2026-04-30') / 30), 'NEAREST_CENT'),
	690
);
// The boundary is the window, not the number 21. A joiner on 6 April is paid in April because
// summary pays them 900 x 25/30 for April, because 6 April is inside the March-21-to-April-20
// window the April run reads.
check(
	'a joiner on the 6th is paid in the month they join',
	settle_('2026-04', '2026-04-06', null).runs,
	true
);
check(
	'a joiner on the last day the window covers is still paid that month',
	settle_('2026-04', '2026-04-20', null).runs,
	true
);
check('the day after it is not', settle_('2026-04', '2026-04-21', null).runs, false);
check(
	'without the policy nothing defers — a joiner on the 28th is paid for three days',
	settle_('2026-04', '2026-04-28', null, PLAIN_CALENDAR).runs,
	true
);

// ── Rule 2: a leaver in the tail settles now, because there is no later run ─────────────────────
//
// A leaver's last day was 27 April 2026. Their April payslip deducts 48.05 of unpaid leave —
// half a day at 2,883/30 — for a half-day taken on 21 April. Under the plain window that day sits
// in the MAY run, which they are not in, so the deduction would simply never be taken.
const apr0082 = settle_('2026-04', '2020-03-09', '2026-04-27');
check('a leaver in the tail still runs', apr0082.runs, true);
check('and their window is extended to the exit date', apr0082.attendance, {
	start: '2026-03-21',
	end: '2026-04-27'
});
check('so the 21 April absence is inside it', apr0082.attendance.end >= '2026-04-21', true);
check(
	'half a day at 2883/30 is the workbook’s 48.05',
	roundMoney(roundMoney(2883 / 30, 'NEAREST_CENT') * 0.5, 'NEAREST_CENT'),
	48.05
);
check(
	'without the policy the tail is left for a run that never happens',
	settle_('2026-04', '2020-03-09', '2026-04-27', PLAIN_CALENDAR).attendance,
	{ start: '2026-03-21', end: '2026-04-20' }
);
check(
	'a leaver before the cutoff needs no extension',
	settle_('2026-01', '2023-05-15', '2026-01-15').attendance,
	{ start: '2025-12-21', end: '2026-01-20' }
);
check(
	'a leaver on the last day of the month extends to it',
	settle_('2026-03', '2023-01-04', '2026-03-31').attendance.end,
	'2026-03-31'
);
check(
	'final-period FULL_PERIOD wages cover the full month before attendance deductions',
	settle_('2026-02', '2022-03-05', '2026-02-27', {
		...PLAIN_CALENDAR,
		fullFinalPeriodWages: true
	}).wageDays,
	{ start: '2026-02-01', end: '2026-02-28' }
);
check(
	'and is never deferred — rule 2 is the mirror of rule 1, not a copy of it',
	settle_('2026-03', '2023-01-04', '2026-03-31').deferral,
	null
);

// ── Rule 3: a leave of absence is deducted in the month it falls in ─────────────────────────────
//
// An employee was on unpaid leave from 1 December 2025 to 30 January 2026, with the rostered rest
// days showing as gaps. Their January payslip deducts 1,371 — twenty-five days at 1,700/31 — and
// their February payslip deducts NOTHING, though the 21 Jan - 20 Feb window contains eight of
// those January days. The absence settled in January, all of it.
const N0340 = [
	...[
		'01',
		'03',
		'04',
		'05',
		'06',
		'07',
		'08',
		'10',
		'11',
		'12',
		'13',
		'14',
		'15',
		'17',
		'18',
		'19',
		'20',
		'21',
		'22',
		'24',
		'26',
		'27',
		'28',
		'29',
		'31'
	].map((day) => `2025-12-${day}`),
	...[
		'01',
		'02',
		'03',
		'04',
		'05',
		'07',
		'08',
		'09',
		'10',
		'11',
		'12',
		'14',
		'15',
		'16',
		'17',
		'18',
		'19',
		'21',
		'22',
		'23',
		'26',
		'27',
		'28',
		'29',
		'30'
	].map((day) => `2026-01-${day}`)
];
const spell0340 = extendedAbsenceDays({
	dates: N0340,
	minimumCalendarDays: 14,
	bridgedGapDays: 7
});
check('the whole two-month absence is one spell', spell0340.size, N0340.length);
check(
	'January’s twenty-five days are all in it',
	[...spell0340].filter((date) => date.startsWith('2026-01')).length,
	25
);
check(
	'twenty-five days at 1700/31 is the workbook’s January figure',
	roundMoney(roundMoney(1700 / 31, 'NEAREST_CENT') * 25, 'NEAREST_CENT'),
	1371
);
// A rest day inside the leave does not end it; a real return to work does.
check(
	'a fortnight’s absence with weekend gaps is one absence',
	extendedAbsenceDays({
		dates: ['2026-05-04', '2026-05-05', '2026-05-11', '2026-05-12', '2026-05-18'],
		minimumCalendarDays: 14,
		bridgedGapDays: 7
	}).size,
	5
);
check(
	'two short absences a month apart are two, and neither is extended',
	extendedAbsenceDays({
		dates: ['2026-05-04', '2026-05-05', '2026-06-08', '2026-06-09'],
		minimumCalendarDays: 14,
		bridgedGapDays: 7
	}).size,
	0
);
check(
	'a scattered day here and there never qualifies',
	extendedAbsenceDays({
		dates: ['2026-05-04', '2026-05-20', '2026-06-02'],
		minimumCalendarDays: 14,
		bridgedGapDays: 7
	}).size,
	0
);

// The selection itself: the same ledger, read by the February run, both ways.
const NPL_TYPE = '00000000-0000-4000-8000-00000000000a';
const NPL_COMPONENT = '00000000-0000-4000-8000-00000000000b';
const leaveTypes = [
	{
		norbital_id: NPL_TYPE,
		code: 'UNPAID_LEAVE',
		payroll_effect: { kind: 'UNPAID', component_id: NPL_COMPONENT }
	}
];
const ledger0340 = N0340.map((date, index) => ({
	norbital_id: `ledger-${index}`,
	leave_type_id: NPL_TYPE,
	entry_date: date,
	kind: 'TAKEN',
	days: -1,
	source_id: null,
	norbital_approval_id: null
}));
const february = companyAWindow('2026-02');
check(
	'the plain window drags eight January days into February',
	unpaidLeaveInWindow({
		ledger: ledger0340,
		window: february.attendance,
		configuration: { leaveTypes }
	})[0]?.days,
	8
);
check(
	'the leave-of-absence rule leaves February with nothing, as the workbook does',
	unpaidLeaveInWindow({
		ledger: ledger0340,
		window: february.attendance,
		month: february.salary,
		extendedDates: spell0340,
		configuration: { leaveTypes }
	}).length,
	0
);
check(
	'and January takes all twenty-five of its own days',
	unpaidLeaveInWindow({
		ledger: ledger0340,
		window: companyAWindow('2026-01').attendance,
		month: companyAWindow('2026-01').salary,
		extendedDates: spell0340,
		configuration: { leaveTypes }
	})[0]?.days,
	25
);

// The population is enrolment in a company-named scheme — never a nationality, which the engine
// does not read and cannot hold.
const NON_CITIZEN = '00000000-0000-4000-8000-0000000000ef';
const EXTENDED_LEAVE_POLICY = readSettlementPolicy({
	settlement_policy: {
		late_joiner_arrears: null,
		final_period: 'FOLLOW_ATTENDANCE_WINDOW',
		final_period_wages: 'FULL_PERIOD',
		extended_unpaid_leave: {
			minimum_calendar_days: 14,
			bridged_gap_days: 7,
			population_contribution_id: NON_CITIZEN
		},
		absence_proration: null,
		overtime_windows: null
	}
});
const registered = (contributionId) => ({
	statutory_contribution_id: contributionId,
	status: { kind: 'REGISTERED' },
	effective_range: { start: '2020-01-01T00:00:00.000Z', end: '9999-12-31T00:00:00.000Z' }
});
check(
	'an employment enrolled in the named scheme is in the population',
	inExtendedLeavePopulation({
		policy: EXTENDED_LEAVE_POLICY,
		statutoryFacts: [registered(NON_CITIZEN)],
		asOf: '2026-01-31'
	}),
	true
);
check(
	'one enrolled only elsewhere is not',
	inExtendedLeavePopulation({
		policy: EXTENDED_LEAVE_POLICY,
		statutoryFacts: [registered('00000000-0000-4000-8000-0000000000aa')],
		asOf: '2026-01-31'
	}),
	false
);
check(
	'a company that names no scheme applies the rule to everyone',
	inExtendedLeavePopulation({
		policy: readSettlementPolicy({
			settlement_policy: {
				late_joiner_arrears: null,
				final_period: 'FOLLOW_ATTENDANCE_WINDOW',
				// Required on the stored policy, so a real row always states them; both values below
				// are what the engine already inferred from their absence.
				final_period_wages: 'PRORATE_TO_EXIT',
				extended_unpaid_leave: {
					minimum_calendar_days: 14,
					bridged_gap_days: 7,
					population_contribution_id: null
				},
				absence_proration: null,
				overtime_windows: null
			}
		}),
		statutoryFacts: [],
		asOf: '2026-01-31'
	}),
	true
);
check(
	'a company that states no rule applies it to nobody',
	inExtendedLeavePopulation({
		policy: PLAIN_CALENDAR,
		statutoryFacts: [registered(NON_CITIZEN)],
		asOf: '2026-01-31'
	}),
	false
);
check('an absent policy column is the plain calendar', readSettlementPolicy({}), PLAIN_CALENDAR);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The ordinary rate of pay and statutory OT controls.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const terms = {
	base_salary: { value: 3451, currency: 'MYR' },
	pay_frequency: 'MONTHLY',
	ordinary_hours_per_week: 48,
	working_days_per_week: 6
};
const myJurisdiction = {
	code: 'MY',
	ordinary_rate_basis: 'DAYS_PER_MONTH',
	ordinary_rate_divisor: 26
};
check('ORP is 3,451 / 26 / 8 = 16.59', ordinaryHourlyRate(terms, myJurisdiction), 16.59);
check('a day’s wages is 3,451 / 26 = 132.73', ordinaryDayWage(terms, myJurisdiction), 132.73);
check(
	'semi-monthly is a payout cadence and does not double the stored monthly salary',
	ordinaryHourlyRate(
		{
			...terms,
			base_salary: { value: 15650, currency: 'PHP' },
			pay_frequency: 'SEMI_MONTHLY',
			ordinary_hours_per_week: 40,
			working_days_per_week: 5
		},
		{
			code: 'PH',
			ordinary_rate_basis: 'DAYS_PER_MONTH',
			ordinary_rate_divisor: 21.75
		}
	),
	89.94
);
check(
	'a PH six-day week uses the statutory 313-day factor',
	ordinaryHourlyRate(
		{
			...terms,
			base_salary: { value: 15650, currency: 'PHP' },
			pay_frequency: 'SEMI_MONTHLY',
			ordinary_hours_per_week: 48,
			working_days_per_week: 6
		},
		{
			code: 'PH',
			ordinary_rate_basis: 'DAYS_PER_MONTH',
			ordinary_rate_divisor: 21.75
		}
	),
	75
);
check(
	'a PH overnight clock overlaps all eight statutory night hours',
	philippineNightWorkHours({
		work_date: '2026-02-03',
		clock_in: '2026-02-03T20:22:00.000+08:00',
		clock_out: '2026-02-04T08:30:00.000+08:00'
	}),
	8
);
check(
	'a daytime clock earns no night differential',
	philippineNightWorkHours({
		work_date: '2026-02-03',
		clock_in: '2026-02-03T08:30:00.000+08:00',
		clock_out: '2026-02-03T17:30:00.000+08:00'
	}),
	0
);
check(
	'a five-day 42.5-hour contract uses its 8.5-hour normal day, not a six-day payroll convention',
	ordinaryHourlyRate(
		{
			...terms,
			base_salary: { value: 2044, currency: 'MYR' },
			ordinary_hours_per_week: 42.5,
			working_days_per_week: 5
		},
		myJurisdiction
	),
	9.25
);
const fiveDayWeekTerms = {
	...terms,
	base_salary: { value: 2044, currency: 'MYR' },
	ordinary_hours_per_week: 42.5,
	working_days_per_week: 5
};
check(
	'five-day week annualises monthly salary over contracted annual hours',
	annualisedContractHourlyRate(fiveDayWeekTerms),
	11.1
);
check(
	'annualised contract rate is selected for OT when configured',
	overtimeHourlyRate(fiveDayWeekTerms, myJurisdiction, 'ANNUALISED_CONTRACT_RATE'),
	11.1
);
check(
	'the statutory option remains available for companies that select it',
	overtimeHourlyRate(fiveDayWeekTerms, myJurisdiction, 'STATUTORY_AGGREGATE'),
	9.25
);
check(
	'an annualised company rate cannot fall below the statutory hourly rate',
	overtimeHourlyRate(
		{
			...terms,
			base_salary: { value: 2600, currency: 'MYR' },
			ordinary_hours_per_week: 56,
			working_days_per_week: 7
		},
		myJurisdiction,
		'ANNUALISED_CONTRACT_RATE'
	),
	12.5
);
check(
	'six-day contract annualisation matches expected hourly rate',
	annualisedContractHourlyRate({
		...terms,
		base_salary: { value: 2088, currency: 'MYR' },
		ordinary_hours_per_week: 45,
		working_days_per_week: 6
	}),
	10.71
);
check(
	'annualised dated OT rounds the 1.5x unit before each dated amount',
	[1, 1, 1, 1].reduce((total, hours) => total + cents(hours * cents(11.1 * 1.5)), 0),
	66.6
);
check(
	'annualised dated OT preserves the unit-rate rounding cent',
	[2, 3, 3, 3, 3, 3, 3].reduce((total, hours) => total + cents(hours * cents(10.71 * 1.5)), 0),
	321.4
);
check(
	'an hours-per-month jurisdiction divides once',
	ordinaryHourlyRate(terms, {
		code: 'ID',
		ordinary_rate_basis: 'HOURS_PER_MONTH',
		ordinary_rate_divisor: 173
	}),
	cents(3451 / 173)
);

const ordinaryRule = {
	norbital_id: 'ot-ordinary',
	day_type: 'ORDINARY',
	authority: 'EA s.60A(1)(a)',
	band: { measure: 'BEYOND_NORMAL', from_hours: 0, to_hours: null },
	award: { kind: 'HOURLY_MULTIPLE', multiple: 1.5 }
};
const sixHourDay = {
	date: '2026-01-06',
	timeEntryId: 't1',
	dayType: 'ORDINARY',
	hours: 6,
	normalHours: 8,
	totalWorkHours: 14
};
const split = priceDay({ day: sixHourDay, rules: [ordinaryRule], retainedHours: 4 });
check(
	'only overtime corresponding to work through 12 total hours remains overtime',
	split.segments.reduce((total, s) => total + s.hours, 0),
	4
);
check(
	'two hours corresponding to work beyond 12 are reclassified, not discarded',
	split.excess.reduce((total, s) => total + s.hours, 0),
	2
);
check(
	'the excess keeps the multiple it earned: 2 × 1.5 = 3 units',
	split.excess.reduce((total, s) => total + s.units, 0),
	3
);
const uncapped = priceDay({
	day: { ...sixHourDay, hours: 3, totalWorkHours: 11 },
	rules: [ordinaryRule],
	retainedHours: 3
});
check('a day below 12 total work hours produces no excess at all', uncapped.excess.length, 0);
check('and all of it is overtime', uncapped.segments[0].hours, 3);

const bandedRules = [
	{
		...ordinaryRule,
		norbital_id: 'id-1',
		band: { measure: 'BEYOND_NORMAL', from_hours: 0, to_hours: 1 },
		award: { kind: 'HOURLY_MULTIPLE', multiple: 1.5 }
	},
	{
		...ordinaryRule,
		norbital_id: 'id-2',
		band: { measure: 'BEYOND_NORMAL', from_hours: 1, to_hours: null },
		award: { kind: 'HOURLY_MULTIPLE', multiple: 2 }
	}
];
const banded = priceDay({
	day: { ...sixHourDay, hours: 3 },
	rules: bandedRules,
	retainedHours: 3
});
check(
	'a banded ladder splits one hour at 1.5 and two at 2.0',
	banded.segments.map((s) => [s.hours, s.multiple]),
	[
		[1, 1.5],
		[2, 2]
	]
);

const monthlyDays = [
	{
		...sixHourDay,
		date: '2026-01-01',
		dayType: 'REST_DAY',
		hours: 10,
		totalWorkHours: 10
	},
	{
		...sixHourDay,
		date: '2026-01-02',
		dayType: 'PUBLIC_HOLIDAY',
		hours: 10,
		totalWorkHours: 10
	},
	...Array.from({ length: 12 }, (_, index) => ({
		...sixHourDay,
		date: `2026-01-${String(index + 3).padStart(2, '0')}`,
		hours: 8,
		totalWorkHours: 11
	})),
	{ ...sixHourDay, date: '2026-01-15', hours: 7, totalWorkHours: 11 },
	{ ...sixHourDay, date: '2026-01-16', hours: 3, totalWorkHours: 11 },
	{ ...sixHourDay, date: '2026-02-01', hours: 3, totalWorkHours: 11 }
];
const monthlyClassified = classifyOvertimeByCalendarMonth({
	days: monthlyDays,
	dailyWorkLimit: null,
	monthlyOrdinaryOvertimeLimit: 104
});
check(
	'the 104-hour counter excludes rest-day and public-holiday work',
	regulatedMonthlyOvertimeHours(monthlyDays, '2026-01'),
	106
);
check(
	'only one hour of a three-hour day remains after 103 ordinary OT hours',
	monthlyClassified.find((entry) => entry.day.date === '2026-01-16')?.retainedHours,
	1
);
check(
	'the remaining two hours are routed to statutory excess',
	monthlyClassified.find((entry) => entry.day.date === '2026-01-16')?.excessHours,
	2
);
check(
	'the statutory OT counter resets on the first of the next calendar month',
	monthlyClassified.find((entry) => entry.day.date === '2026-02-01')?.retainedHours,
	3
);
check(
	'daily excess is also floored to a half-hour increment',
	classifyOvertimeByCalendarMonth({
		days: [{ ...sixHourDay, hours: 4, totalWorkHours: 12.6 }],
		dailyWorkLimit: 12,
		monthlyOrdinaryOvertimeLimit: null
	})[0]?.excessHours,
	0.5
);
check(
	'less than half an hour beyond 12 does not create a fractional excess unit',
	classifyOvertimeByCalendarMonth({
		days: [{ ...sixHourDay, hours: 4, totalWorkHours: 12.4 }],
		dailyWorkLimit: 12,
		monthlyOrdinaryOvertimeLimit: null
	})[0]?.excessHours,
	0
);

const fixedSchedule = resolveSchedule({
	window: { start: '2026-01-03', end: '2026-01-04' },
	dates: ['2026-01-03', '2026-01-04'],
	terms: () => ({
		ordinary_hours_per_week: 40,
		working_days_per_week: 5,
		rest_day: 'SUN'
	}),
	rosterEntries: [],
	configuration: { holidays: new Map(), shiftById: new Map() }
});
check(
	'a fixed five-day week resolves Saturday OFF and Sunday REST',
	[fixedSchedule.get('2026-01-03')?.dayType, fixedSchedule.get('2026-01-04')?.dayType],
	['OFF_DAY', 'REST_DAY']
);

const shift = {
	code: 'TEST',
	start_time: '08:30',
	end_time: '17:30',
	break_minutes: 60,
	effective_range: {
		start: '2020-01-01T00:00:00.000Z',
		end: '9999-12-31T00:00:00.000Z'
	}
};
const dynamicSchedule = resolveSchedule({
	window: { start: '2026-01-06', end: '2026-01-07' },
	dates: ['2026-01-06', '2026-01-07'],
	terms: () => ({
		ordinary_hours_per_week: 45,
		working_days_per_week: 6,
		rest_day: 'SUN'
	}),
	rosterEntries: [
		{ work_date: '2026-01-06', shift_definition_id: 'shift', designation: 'REST' },
		{ work_date: '2026-01-07', shift_definition_id: 'shift', designation: 'WORK' }
	],
	configuration: {
		holidays: new Map([
			[
				'2026-01-06',
				{ date: '2026-01-06', substitutes_date: null, name: 'Holiday', scope: { kind: 'NATIONAL' } }
			]
		]),
		shiftById: new Map([['shift', shift]])
	}
});
check(
	'a holiday on a dynamically rostered rest day makes the next rostered working day a substitute holiday',
	[dynamicSchedule.get('2026-01-06')?.dayType, dynamicSchedule.get('2026-01-07')?.dayType],
	['REST_DAY', 'PUBLIC_HOLIDAY']
);
// ── statutory overtime coverage, read from the jurisdiction's cited rule ────────────────────────
// The Malaysian row as seeded in Core: Employment Act 1955 First Schedule paras 1A, 2 and 3.
const MY_COVERAGE_RULE = {
	wage_ceiling: { value: 4000, currency: 'MYR' },
	ceiling_is_inclusive: true,
	wage_basis: 'STATUTORY_WAGES',
	category_basis: 'STATUTORY_WORK_CATEGORY',
	exempt_categories: ['MANUAL_LABOUR', 'MANUAL_LABOUR_SUPERVISOR', 'COMMERCIAL_VEHICLE_OPERATOR'],
	excluded_categories: ['VESSEL_WORK'],
	authority: 'Employment Act 1955 First Schedule paras 1A, 2 and 3'
};
const coverageArgs = (category, salary, comparand = salary) => ({
	rule: MY_COVERAGE_RULE,
	jurisdictionCode: 'MY',
	wages: {
		BASE_SALARY: { value: salary, currency: 'MYR' },
		STATUTORY_WAGES: { value: comparand, currency: 'MYR' }
	},
	statutoryWorkCategory: category,
	workClassification: 'EA_COVERED',
	employeeNumber: 'E-0001'
});

check(
	'manual labour above RM4,000 remains statutorily OT-pay covered — First Schedule para 2(1)',
	isStatutoryOvertimePayCovered(coverageArgs('MANUAL_LABOUR', 5000)),
	true
);
check(
	'a supervisor of manual labour is covered irrespective of wages — para 2(3)',
	isStatutoryOvertimePayCovered(coverageArgs('MANUAL_LABOUR_SUPERVISOR', 12000)),
	true
);
check(
	'vessel work is outside the ladder at any wage — para 2(4) disapplies Part XII',
	isStatutoryOvertimePayCovered(coverageArgs('VESSEL_WORK', 1000)),
	false
);
check(
	'a jurisdiction with no coverage rule covers everyone, rather than nobody',
	isStatutoryOvertimePayCovered({ ...coverageArgs('NON_MANUAL', 99000), rule: null }),
	true
);
// The First Schedule tests para 3 wages — s.2 wages less commissions, subsistence allowance and
// overtime payment — which the engine derives from the pay components and their entries. A person
// on RM3,800 basic plus a RM500 fixed allowance earns RM4,300 of para 3 wages and is outside the
// ladder, even though their base salary alone would have kept them inside it.
check(
	'wages exactly at the ceiling stay covered — para 1A bites only on wages that EXCEED it',
	isStatutoryOvertimePayCovered(coverageArgs('NON_MANUAL', 4000)),
	true
);
check(
	'an allowance that takes para 3 wages past the ceiling ends coverage',
	isStatutoryOvertimePayCovered(coverageArgs('NON_MANUAL', 3800, 4300)),
	false
);
check(
	'base salary alone never answers a STATUTORY_WAGES rule — the comparand is wider',
	isStatutoryOvertimePayCovered(coverageArgs('NON_MANUAL', 3000)),
	true
);

// ── the para 3 comparand, classified from the pay component model ───────────────────────────────
// s.2: basic wages AND all other cash payments for work done. Para 3 lessens that by commissions,
// subsistence allowance and overtime payment. The classification below is the statute read against
// what a pay component row can say.
const component = (kind, source) => ({
	policy: kind == null ? null : { kind },
	definition: source == null ? null : { source }
});
check(
	'the contracted wage is basic wages',
	classifyWageComparand(component('EARNING', 'SCHEDULE')),
	'BASIC_WAGES'
);
check(
	'an earning entry is another cash payment for work done',
	classifyWageComparand(component('EARNING', 'ENTRY')),
	'CASH_FOR_WORK'
);
check(
	'a formula earning is another cash payment for work done',
	classifyWageComparand(component('EARNING', 'FORMULA')),
	'CASH_FOR_WORK'
);
check(
	'the overtime ladder is overtime payment, which para 3 takes out',
	classifyWageComparand(component('EARNING', 'OVERTIME')),
	'OVERTIME_PAY'
);
check(
	'reclassified excess hours are still overtime payment',
	classifyWageComparand(component('EARNING', 'OVERTIME_EXCESS')),
	'OVERTIME_PAY'
);
check(
	'a reimbursement is not a cash payment for work done',
	classifyWageComparand(component('NON_WAGE_PAYMENT', 'ENTRY')),
	'NOT_WAGES'
);
check(
	'a deduction is not wages',
	classifyWageComparand(component('DEDUCTION', 'ENTRY')),
	'NOT_WAGES'
);
check(
	'information is not wages',
	classifyWageComparand(component('INFORMATION', 'FORMULA')),
	'NOT_WAGES'
);

const comparand = deriveStatutoryWages({
	baseSalary: { value: 3800, currency: 'MYR' },
	payments: [
		{ category: 'CASH_FOR_WORK', amount: 500 }, // fixed allowance
		{ category: 'CASH_FOR_WORK', amount: -50 }, // a reversal on the same component takes back
		{ category: 'OVERTIME_PAY', amount: 700 }, // para 3 excludes overtime payment
		{ category: 'NOT_WAGES', amount: 300 }, // a reimbursement
		{ category: 'BASIC_WAGES', amount: 0 } // basic comes from the terms, not an entry
	]
});
check('the comparand is basic plus cash-for-work, less nothing else', comparand, {
	value: 4250,
	currency: 'MYR'
});
check(
	'a ceiling in another currency than the wages still stops the run',
	(() => {
		try {
			isStatutoryOvertimePayCovered({
				...coverageArgs('NON_MANUAL', 3000),
				rule: {
					...MY_COVERAGE_RULE,
					wage_ceiling: { value: 4000, currency: 'SGD' }
				}
			});
			return 'no error';
		} catch (error) {
			return /different currency/.test(error.message) && /E-0001/.test(error.message);
		}
	})(),
	true
);

// ── rest breaks, read from the jurisdiction's cited rows ────────────────────────────────────────
// The figures are the seeded rows' — s.60A(1)(a), the s.60A(1) proviso (ii), art.85 and UU 13/2003
// Pasal 79(2)(a) — never the engine's.
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
check('the ordinary break resolves with its window and its silence on pay', breaks.get('ALWAYS'), {
	appliesWhen: 'ALWAYS',
	afterConsecutiveHours: 5,
	minimumMinutes: 30,
	countsAsWorkedTime: null,
	authority: 'Employment Act 1955 s.60A(1)(a)'
});
check(
	'the continuous-attendance variant coexists with the ordinary one',
	breaks.get('CONTINUOUS_ATTENDANCE')?.minimumMinutes,
	45
);
check(
	'a break the statute ties to no window keeps its null trigger',
	resolveRestBreakRules([
		{
			after_consecutive_hours: null,
			minimum_minutes: 60,
			counts_as_worked_time: null,
			applies_when: 'ALWAYS',
			authority: 'Labor Code of the Philippines art.85'
		}
	]).get('ALWAYS')?.afterConsecutiveHours,
	null
);
check(
	'a break stated as not counted in working hours keeps the statute s own false',
	resolveRestBreakRules([
		{
			after_consecutive_hours: 4,
			minimum_minutes: 30,
			counts_as_worked_time: false,
			applies_when: 'ALWAYS',
			authority: 'UU 13/2003 Pasal 79(2)(a)'
		}
	]).get('ALWAYS')?.countsAsWorkedTime,
	false
);
throws('two rows of the same kind are a seeding fault, not a choice', () =>
	resolveRestBreakRules([
		{
			after_consecutive_hours: 5,
			minimum_minutes: 30,
			counts_as_worked_time: null,
			applies_when: 'ALWAYS',
			authority: 'one'
		},
		{
			after_consecutive_hours: 8,
			minimum_minutes: 45,
			counts_as_worked_time: null,
			applies_when: 'ALWAYS',
			authority: 'two'
		}
	])
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Reversal signs are transitive — reversing a reversal restores the original.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const original = { norbital_id: 'e1', origin: { kind: 'ONE_OFF', note: '' } };
const reversal = {
	norbital_id: 'e2',
	origin: { kind: 'REVERSAL', reverses_entry_id: 'e1', reason: 'wrong' }
};
const reversalOfReversal = {
	norbital_id: 'e3',
	origin: { kind: 'REVERSAL', reverses_entry_id: 'e2', reason: 'oops' }
};
const entryIndex = new Map(
	[original, reversal, reversalOfReversal].map((entry) => [entry.norbital_id, entry])
);
check('an ordinary entry pays', entrySign(original, entryIndex), 1);
check('a reversal takes back', entrySign(reversal, entryIndex), -1);
check(
	'a reversal of a reversal restores — it does not double the negative',
	entrySign(reversalOfReversal, entryIndex),
	1
);
const selfReversing = {
	norbital_id: 'e4',
	origin: { kind: 'REVERSAL', reverses_entry_id: 'e4', reason: 'loop' }
};
throws('a reversal cycle is refused rather than hanging the run', () =>
	entrySign(selfReversing, new Map([['e4', selfReversing]]))
);

/* ── Rest-day and public-holiday work is priced by statute, from the seeded rules ──────────────
 *
 * EA s.60(3): a rest day's work up to the normal day pays a day's wages, and only the hours past
 * it enter the hourly ladder. The pre-refactor engine paid every hour at a flat hourly multiple
 * instead — roughly RM88 a day more, and routed to an EPF-liable component where statutory
 * overtime is EPF-exempt. These cases exist so that reading cannot come back by accident.
 */
const restDayRule = (measure, from, to, award, multiple) => ({
	norbital_id: `ot-${measure}-${from}`,
	day_type: 'REST_DAY',
	band:
		measure === 'FROM_START_OF_DAY'
			? { measure, from_fraction: from, to_fraction: to }
			: { measure, from_hours: from, to_hours: to },
	award: { kind: award, multiple }
});

// Malaysia, rest day: up to half a normal day pays 0.5 day's wages, up to a full day pays 1.0,
// and hours beyond the normal day pay 2.0 × the hourly rate.
const malaysiaRestDay = [
	restDayRule('FROM_START_OF_DAY', 0, 0.5, 'DAY_WAGE_MULTIPLE', 0.5),
	restDayRule('FROM_START_OF_DAY', 0.5, 1, 'DAY_WAGE_MULTIPLE', 1),
	restDayRule('BEYOND_NORMAL', 0, null, 'HOURLY_MULTIPLE', 2)
];
const restDay = (hours) => ({
	date: '2026-01-11',
	timeEntryId: 't-rest',
	dayType: 'REST_DAY',
	hours,
	normalHours: 8,
	totalWorkHours: hours
});

const eightOnARestDay = priceDay({
	day: restDay(8),
	rules: malaysiaRestDay,
	retainedHours: 8
});
check(
	'eight hours on a rest day pays one day of wages, not eight hourly multiples',
	eightOnARestDay.segments.filter((segment) => segment.award === 'DAY_WAGE_MULTIPLE').length,
	1
);
check(
	"a day's wages is paid once, at the highest band entered",
	eightOnARestDay.segments.find((segment) => segment.award === 'DAY_WAGE_MULTIPLE')?.multiple,
	1
);
check(
	'no hour inside the normal day reaches the hourly ladder',
	eightOnARestDay.segments
		.filter((segment) => segment.award === 'HOURLY_MULTIPLE')
		.reduce((total, segment) => total + segment.hours, 0),
	0
);

const tenOnARestDay = priceDay({
	day: restDay(10),
	rules: malaysiaRestDay,
	retainedHours: 10
});
check(
	'only the hours past the normal day enter the hourly ladder',
	tenOnARestDay.segments
		.filter((segment) => segment.award === 'HOURLY_MULTIPLE')
		.reduce((total, segment) => total + segment.hours, 0),
	2
);

const halfDay = priceDay({ day: restDay(3), rules: malaysiaRestDay, retainedHours: 3 });
check(
	'under half a normal day pays the half-day band, not the full one',
	halfDay.segments.find((segment) => segment.award === 'DAY_WAGE_MULTIPLE')?.multiple,
	0.5
);
const restDaySplit = priceDay({
	day: restDay(11),
	rules: malaysiaRestDay,
	retainedHours: 11
});
check(
	'eleven rest-day hours retain the full statutory rest-day award',
	restDaySplit.segments.find((segment) => segment.award === 'DAY_WAGE_MULTIPLE')?.multiple,
	1
);
check(
	'eleven total work hours produce no incentive reclassification',
	restDaySplit.excess.length,
	0
);

const thirteenHourRestDaySplit = priceDay({
	day: restDay(13),
	rules: malaysiaRestDay,
	retainedHours: 12
});
check(
	'thirteen rest-day hours keep the award through hour 12 and reclassify exactly hour 13',
	{
		overtimeDayWageUnits: thirteenHourRestDaySplit.segments
			.filter((segment) => segment.award === 'DAY_WAGE_MULTIPLE')
			.reduce((total, segment) => total + segment.multiple, 0),
		overtimeHourlyHours: thirteenHourRestDaySplit.segments
			.filter((segment) => segment.award === 'HOURLY_MULTIPLE')
			.reduce((total, segment) => total + segment.hours, 0),
		incentiveDayWageUnits: thirteenHourRestDaySplit.excess
			.filter((segment) => segment.valuedAt === 'ORDINARY_DAY_WAGE')
			.reduce((total, segment) => total + segment.units, 0),
		incentiveHourlyHours: thirteenHourRestDaySplit.excess
			.filter((segment) => segment.valuedAt === 'ORDINARY_HOURLY')
			.reduce((total, segment) => total + segment.hours, 0),
		incentiveHourlyUnits: thirteenHourRestDaySplit.excess
			.filter((segment) => segment.valuedAt === 'ORDINARY_HOURLY')
			.reduce((total, segment) => total + segment.units, 0)
	},
	{
		overtimeDayWageUnits: 1,
		overtimeHourlyHours: 4,
		incentiveDayWageUnits: 0,
		incentiveHourlyHours: 1,
		incentiveHourlyUnits: 2
	}
);

const malaysiaPublicHoliday = [
	{
		...restDayRule('FROM_START_OF_DAY', 0, 1, 'DAY_WAGE_MULTIPLE', 2),
		day_type: 'PUBLIC_HOLIDAY'
	},
	{
		...restDayRule('BEYOND_NORMAL', 0, null, 'HOURLY_MULTIPLE', 3),
		day_type: 'PUBLIC_HOLIDAY'
	}
];
const thirteenHourPublicHolidaySplit = priceDay({
	day: { ...restDay(13), dayType: 'PUBLIC_HOLIDAY' },
	rules: malaysiaPublicHoliday,
	retainedHours: 12
});
check(
	'thirteen public-holiday hours reclassify only hour 13 at the statutory 3× value',
	{
		overtimeDayWageUnits: thirteenHourPublicHolidaySplit.segments
			.filter((segment) => segment.award === 'DAY_WAGE_MULTIPLE')
			.reduce((total, segment) => total + segment.multiple, 0),
		overtimeHourlyHours: thirteenHourPublicHolidaySplit.segments
			.filter((segment) => segment.award === 'HOURLY_MULTIPLE')
			.reduce((total, segment) => total + segment.hours, 0),
		incentiveDayWageUnits: thirteenHourPublicHolidaySplit.excess
			.filter((segment) => segment.valuedAt === 'ORDINARY_DAY_WAGE')
			.reduce((total, segment) => total + segment.units, 0),
		incentiveHourlyHours: thirteenHourPublicHolidaySplit.excess
			.filter((segment) => segment.valuedAt === 'ORDINARY_HOURLY')
			.reduce((total, segment) => total + segment.hours, 0),
		incentiveHourlyUnits: thirteenHourPublicHolidaySplit.excess
			.filter((segment) => segment.valuedAt === 'ORDINARY_HOURLY')
			.reduce((total, segment) => total + segment.units, 0)
	},
	{
		overtimeDayWageUnits: 2,
		overtimeHourlyHours: 4,
		incentiveDayWageUnits: 0,
		incentiveHourlyHours: 1,
		incentiveHourlyUnits: 3
	}
);

// A jurisdiction that states no FROM_START_OF_DAY band pays no day's wages — Singapore's single
// open hourly band. The entitlement is data, not a code path.
const singaporeRestDay = [restDayRule('BEYOND_NORMAL', 0, null, 'HOURLY_MULTIPLE', 1.5)];
const singapore = priceDay({
	day: restDay(8),
	rules: singaporeRestDay,
	retainedHours: 8
});
check(
	'a jurisdiction stating no day-wage band pays every hour hourly',
	singapore.segments
		.filter((segment) => segment.award === 'HOURLY_MULTIPLE')
		.reduce((total, segment) => total + segment.hours, 0),
	8
);
check(
	'and pays no day wage at all',
	singapore.segments.filter((segment) => segment.award === 'DAY_WAGE_MULTIPLE').length,
	0
);

/* ── An absence is prorated, not overtime-rated ────────────────────────────────────────────────
 *
 * Verified against the source workbook: for 2026-01 every employee's `no_pay_leave` divides by
 * `round(basic / 31, cent)` into a clean half-day count, and by `basic / 26` into nothing.
 * Example: basic 3,451, npl 55.66 → 3451/31 = 111.32, 55.66 / 111.32 = exactly 0.5 days.
 * At the EA s.60I divisor of 26 the same half day would withhold 66.37 — 19% too much.
 */
const { absenceDayRate } = await server.ssrLoadModule(lib('ordinary-rate'));
const januaryTerms = {
	base_salary: { value: 3451, currency: 'MYR' },
	pay_frequency: 'MONTHLY',
	ordinary_hours_per_week: 45,
	working_days_per_week: 6
};
const january = { start: '2026-01-01', end: '2026-01-31' };
const calendarMY = {
	// `ordinaryRateDivisor` branches on the jurisdiction code for the Philippine 313-day
	// alternative, so a jurisdiction fixture that omits it is only ever "not PH" by accident.
	code: 'MY',
	proration: { by: 'CALENDAR_DAYS' },
	ordinary_rate_divisor: 26,
	ordinary_rate_basis: 'DAYS_PER_MONTH'
};
const absenceRate = (jurisdiction, period = january) =>
	absenceDayRate({ terms: januaryTerms, jurisdiction, period, workingDaysIn: () => 26 });

check('a January absence day is basic / 31, to the cent', absenceRate(calendarMY), 111.32);
check(
	'half a day withheld reproduces the workbook exactly',
	roundMoney(absenceRate(calendarMY) * 0.5, 'NEAREST_CENT'),
	55.66
);
check(
	'February uses its own 28 days, not the prior month',
	absenceRate(calendarMY, { start: '2026-02-01', end: '2026-02-28' }),
	roundMoney(3451 / 28, 'NEAREST_CENT')
);
check(
	'the overtime divisor is NOT the absence divisor',
	ordinaryDayWage(januaryTerms, calendarMY),
	roundMoney(3451 / 26, 'NEAREST_CENT')
);
check(
	'a WORKING_DAYS jurisdiction prorates on working days instead',
	absenceDayRate({
		terms: januaryTerms,
		jurisdiction: {
			proration: { by: 'WORKING_DAYS' },
			ordinary_rate_divisor: 26,
			ordinary_rate_basis: 'DAYS_PER_MONTH'
		},
		period: january,
		workingDaysIn: () => 22
	}),
	roundMoney(3451 / 22, 'NEAREST_CENT')
);
check(
	'monthly NPL uses the configured 21.75-day fixed-days cadence override',
	absenceDayRate({
		terms: {
			base_salary: { value: 25000, currency: 'PHP' },
			pay_frequency: 'MONTHLY',
			ordinary_hours_per_week: 40,
			working_days_per_week: 5
		},
		jurisdiction: {
			proration: COMPANY_B_POLICY.absenceProration[0].basis,
			ordinary_rate_divisor: 21.75,
			ordinary_rate_basis: 'DAYS_PER_MONTH'
		},
		period: { start: '2026-02-01', end: '2026-02-28' },
		workingDaysIn: () => 16
	}),
	1149.43
);
/* ── A calendar day survives the process time zone ─────────────────────────────────────────────
 *
 * A `date` column has no time zone, and it must mean the same day in every process that reads it.
 * The Postgres driver used to hand one over as a `Date` at the **host's** local midnight — an
 * instant, and an instant is a different day in a different zone. A tenant workspace runs in a
 * container with no `TZ` while the host that queried for it runs wherever the operator is, so a
 * hire date of 2026-01-01 read on a machine in Asia/Singapore arrived in the runtime as
 * 2025-12-31: a day earlier, in the previous month, in a period with no terms covering it.
 *
 * The driver now yields the day as the `YYYY-MM-DD` text it read off the wire, and this checks
 * both halves of the contract — the text is taken as written, and a `Date`, if one ever appears,
 * is read as the UTC-anchored instant it is. Neither answer depends on where this process runs.
 */
const { dateKey: calendarDay } = await server.ssrLoadModule(lib('dates'));
check('the driver’s day text is taken as written', calendarDay('2026-01-01'), '2026-01-01');
check('a year boundary is not rolled back', calendarDay('2026-01-01'), '2026-01-01');
check(
	'a stored UTC instant keeps its stated day',
	calendarDay('2026-01-01T00:00:00.000Z'),
	'2026-01-01'
);
check('a UTC-anchored Date keeps its day', calendarDay(new Date('2026-01-01')), '2026-01-01');
check(
	'a UTC-anchored month boundary keeps its day',
	calendarDay(new Date('2026-03-01')),
	'2026-03-01'
);

/* And the consequence that actually broke a run: someone hired on the first of the period is a
 * plain starter, not a late joiner owed the month before. The arrears rule is right — feed it the
 * shifted day and it correctly claims a December it was never meant to see — so the guard is the
 * hire date itself, and this pins that it reaches the rule unmoved. */
const janStarter = settle_('2026-01', calendarDay('2026-01-01'), null);
check('someone hired on 1 January is paid in January', janStarter.runs, true);
check('their January covers the whole month', janStarter.employedDays, {
	start: '2026-01-01',
	end: '2026-01-31'
});
check('and nothing is owed for December', janStarter.arrearsFor, null);
check('nor is any period deferred', janStarter.deferral, null);
check(
	'while a genuine 31 December joiner is owed that one day',
	settle_('2026-01', '2025-12-31', null).arrearsFor?.days,
	{ start: '2025-12-31', end: '2025-12-31' }
);

await server.close();

console.log(`\n${passed} assertions passed.`);
if (failures.length > 0) {
	console.error(`\n${failures.length} FAILED:\n`);
	for (const failure of failures) console.error(`  ✗ ${failure}\n`);
	process.exitCode = 1;
} else {
	console.log('All payroll arithmetic verified.\n');
}
