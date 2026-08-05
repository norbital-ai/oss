// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	formatPayrollCycleDate,
	instalmentPayPeriod,
	repaymentConsumptionBySequence,
	repaymentRunLifecycleByPeriod,
	repaymentShortfall,
	resolveRepaymentConsumption
} from '../../lib/ui/repayment-schedule/repayment-consumption.ts';

test('indexes complete payroll consumption provenance by schedule sequence', () => {
	const references = repaymentConsumptionBySequence([
		{
			repayment_sequence: 2,
			entry_payslip_lines: [
				{
					norbital_created_at: '2026-07-31T08:15:00.000Z',
					norbital_id: 'line-2',
					sequence: 7,
					amount: '167',
					payslip_line_payslip: {
						norbital_id: 'payslip-2',
						payslip_payroll_run: {
							norbital_id: 'run-2',
							period: '2026-07',
							pay_date: '2026-07-31'
						}
					}
				}
			]
		}
	]);

	assert.deepEqual(references.get(2), {
		payslipLineId: 'line-2',
		payslipId: 'payslip-2',
		payrollRunId: 'run-2',
		payslipLineSequence: 7,
		payrollPeriod: '2026-07',
		cycleDate: '2026-07-31',
		consumedAt: '2026-07-31T08:15:00.000Z',
		recoveredAmount: 167
	});
});

test('does not mark a schedule row consumed from an incomplete source link', () => {
	const references = repaymentConsumptionBySequence([
		{
			repayment_sequence: 0,
			entry_payslip_lines: [
				{
					norbital_created_at: '2026-07-31T08:15:00.000Z',
					norbital_id: 'line-draft',
					sequence: 1,
					payslip_line_payslip: null
				}
			]
		}
	]);

	assert.equal(references.size, 0);
});

test('formats the payroll cycle date as DD-MM-YY without timezone conversion', () => {
	assert.equal(formatPayrollCycleDate('2026-07-31'), '31-07-26');
	assert.equal(formatPayrollCycleDate('2026-07-31T00:00:00.000Z'), '31-07-26');
});

test('an instalment settles in the run its due date names, as the hook materialises it', () => {
	assert.equal(instalmentPayPeriod('2026-04-01'), '2026-04');
	assert.equal(instalmentPayPeriod('2026-09-01T00:00:00.000Z'), '2026-09');
});

/**
 * The schedule that cost the user an afternoon: Hari Raya 2026 (NHPMY0290), six instalments from
 * 2026-04-01, every one of them reading "Not consumed" while 2026-01 … 2026-04 were all paid.
 */
test('the reported schedule separates a closed period from one that is merely waiting', () => {
	const runs = repaymentRunLifecycleByPeriod([
		{ period: '2026-01', lifecycle: 'PAID' },
		{ period: '2026-02', lifecycle: 'PAID' },
		{ period: '2026-03', lifecycle: 'PAID' },
		{ period: '2026-04', lifecycle: 'PAID' }
	]);
	const dueDates = [
		'2026-04-01',
		'2026-05-01',
		'2026-06-01',
		'2026-07-01',
		'2026-08-01',
		'2026-09-01'
	];
	const cells = dueDates.map((dueDate) =>
		resolveRepaymentConsumption({
			dueDate,
			reference: undefined,
			runLifecycleByPeriod: runs,
			today: '2026-08-05'
		})
	);

	assert.deepEqual(
		cells.map((cell) => cell.status),
		[
			// April was paid without it — the only row that is actually a defect.
			'unrecovered',
			// May, June and July are due but were never run.
			'awaiting_run',
			'awaiting_run',
			'awaiting_run',
			// August is due today, and still has no run.
			'awaiting_run',
			// September has not come round yet.
			'not_due'
		]
	);
	assert.equal(cells[0].period, '2026-04');
	assert.equal(cells[5].period, '2026-09');
});

test('a draft run for the due period asks to be recalculated rather than blaming the schedule', () => {
	const cell = resolveRepaymentConsumption({
		dueDate: '2026-05-01',
		reference: undefined,
		runLifecycleByPeriod: repaymentRunLifecycleByPeriod([
			{ period: '2026-05', lifecycle: 'DRAFT' }
		]),
		today: '2026-08-05'
	});

	assert.deepEqual(cell, { status: 'awaiting_rebuild', period: '2026-05' });
});

test('a paid period outranks the calendar even when the due date is still ahead', () => {
	const cell = resolveRepaymentConsumption({
		dueDate: '2026-09-01',
		reference: undefined,
		runLifecycleByPeriod: repaymentRunLifecycleByPeriod([{ period: '2026-09', lifecycle: 'PAID' }]),
		today: '2026-08-05'
	});

	assert.deepEqual(cell, { status: 'unrecovered', period: '2026-09' });
});

test('a persisted payslip line still outranks every calendar state', () => {
	const reference = {
		payslipLineId: 'line-1',
		payslipId: 'payslip-1',
		payrollRunId: 'run-1',
		payslipLineSequence: 4,
		payrollPeriod: '2026-04',
		cycleDate: '2026-04-25',
		consumedAt: '2026-04-25T02:00:00.000Z',
		recoveredAmount: 167
	};
	const cell = resolveRepaymentConsumption({
		dueDate: '2026-04-01',
		reference,
		runLifecycleByPeriod: repaymentRunLifecycleByPeriod([{ period: '2026-04', lifecycle: 'PAID' }]),
		today: '2026-08-05'
	});

	assert.deepEqual(cell, { status: 'consumed', reference });
});

test('a squeezed net leaves the recovered amount visible against the scheduled one', () => {
	// settle.ts reduces the deduction to whatever net could bear and carries the rest as arrears.
	// The line still exists, so the row reads "consumed" — the amount is the only place the
	// operator can see that payroll took 100.00 of the 167.00 it was asked for.
	const reference = { recoveredAmount: 100 };
	assert.equal(repaymentShortfall(167, reference), 67);
	assert.equal(repaymentShortfall(167, { recoveredAmount: 167 }), null);
	assert.equal(repaymentShortfall(167, { recoveredAmount: null }), null);
});
