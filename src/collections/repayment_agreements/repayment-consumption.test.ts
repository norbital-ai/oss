// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	formatPayrollCycleDate,
	repaymentConsumptionBySequence
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
		consumedAt: '2026-07-31T08:15:00.000Z'
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
