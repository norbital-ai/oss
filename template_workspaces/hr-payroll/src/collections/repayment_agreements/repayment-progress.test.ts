// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import { repaymentProgress } from './lib/repayment-progress.ts';

test('an instalment is paid when it has a payslip source link', () => {
	assert.deepEqual(
		repaymentProgress(300, 3, [
			{ amount: '100', repayment_sequence: 0, entry_payslip_sources: [{}] },
			{ amount: '100', repayment_sequence: 1, entry_payslip_sources: [] },
			{ amount: '100', repayment_sequence: 2, entry_payslip_sources: null }
		]),
		{
			paidAmount: 100,
			outstandingAmount: 200,
			paidInstalments: 1,
			totalInstalments: 3,
			settled: false
		}
	);
});

test('duplicate links and duplicate rows cannot double-count a schedule sequence', () => {
	const progress = repaymentProgress(200, 2, [
		{ amount: '100', repayment_sequence: 0, entry_payslip_sources: [{}, {}] },
		{ amount: '100', repayment_sequence: 0, entry_payslip_sources: [{}] },
		{ amount: '100', repayment_sequence: 1, entry_payslip_sources: [{}] }
	]);
	assert.equal(progress?.paidAmount, 200);
	assert.equal(progress?.paidInstalments, 2);
	assert.equal(progress?.settled, true);
});

test('a fully-valued but incomplete schedule is not marked settled', () => {
	const progress = repaymentProgress(200, 2, [
		{ amount: '200', repayment_sequence: 0, entry_payslip_sources: [{}] }
	]);
	assert.equal(progress?.outstandingAmount, 0);
	assert.equal(progress?.settled, false);
});
