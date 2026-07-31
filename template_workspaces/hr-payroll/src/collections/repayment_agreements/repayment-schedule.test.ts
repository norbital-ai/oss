// @ts-nocheck -- executed directly by Node with --experimental-strip-types.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
	distributeRepaymentSchedule,
	monthlyDueDates,
	repaymentScheduleIssues,
	repaymentScheduleTotal
} from './lib/repayment-schedule.ts';

test('equal provisioning preserves the principal exactly in cents', () => {
	const schedule = distributeRepaymentSchedule(2044, monthlyDueDates('2026-01-31', 3));
	assert.deepEqual(schedule, [
		{ due_date: '2026-01-31', amount: 681.33 },
		{ due_date: '2026-02-28', amount: 681.33 },
		{ due_date: '2026-03-31', amount: 681.34 }
	]);
	assert.equal(repaymentScheduleTotal(schedule), 2044);
});

test('a schedule whose amounts do not equal principal is rejected', () => {
	const issues = repaymentScheduleIssues({
		principal: 100,
		repayBy: '2026-02-28',
		schedule: [
			{ due_date: '2026-01-31', amount: 40 },
			{ due_date: '2026-02-28', amount: 50 }
		]
	});
	assert.ok(issues.some((issue) => issue.includes('100.00 exactly')));
	assert.ok(issues.some((issue) => issue.includes('90.00')));
});

test('a final instalment after repay-by is rejected', () => {
	const issues = repaymentScheduleIssues({
		principal: 100,
		repayBy: '2026-02-27',
		schedule: [
			{ due_date: '2026-01-31', amount: 50 },
			{ due_date: '2026-02-28', amount: 50 }
		]
	});
	assert.deepEqual(issues, [
		'The final repayment 2026-02-28 is later than the repay-by date 2026-02-27.'
	]);
});

test('the repay-by date itself is allowed', () => {
	assert.deepEqual(
		repaymentScheduleIssues({
			principal: 100,
			repayBy: '2026-02-28',
			schedule: [
				{ due_date: '2026-01-31', amount: 50 },
				{ due_date: '2026-02-28', amount: 50 }
			]
		}),
		[]
	);
});

test('dates must be unique and strictly increasing', () => {
	const issues = repaymentScheduleIssues({
		principal: 100,
		repayBy: '2026-03-31',
		schedule: [
			{ due_date: '2026-02-28', amount: 50 },
			{ due_date: '2026-02-28', amount: 50 }
		]
	});
	assert.ok(issues.includes('Repayment dates must be unique and strictly increasing.'));
});
