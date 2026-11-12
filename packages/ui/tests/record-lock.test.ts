import { describe, expect, it } from 'vitest';
import { matchesLock } from '../src/record/lock.js';

describe('a record lock declared on a model', () => {
	it('locks a settled reference and keeps an unset reference editable', () => {
		const lock = { payslip_id: { is_null: false } };
		expect(matchesLock({ payslip_id: null }, lock)).toBe(false);
		expect(matchesLock({}, lock)).toBe(false);
		expect(matchesLock({ payslip_id: 'settlement' }, lock)).toBe(true);
		expect(matchesLock({ payslip_id: null }, { payslip_id: { is_null: true } })).toBe(true);
		expect(matchesLock({ payslip_id: 'settlement' }, { payslip_id: { is_null: true } })).toBe(
			false
		);
	});
	it('matches own fields and the boolean combinations the declaration language allows', () => {
		expect(matchesLock({ status: 'paid', settled: true }, { status: { eq: 'paid' } })).toBe(true);
		expect(matchesLock({ status: 'open' }, { status: { eq: 'paid' } })).toBe(false);
		expect(
			matchesLock(
				{ status: 'paid', settled: true },
				{ and: [{ status: { eq: 'paid' } }, { settled: { eq: true } }] }
			)
		).toBe(true);
		expect(
			matchesLock(
				{ status: 'paid', settled: false },
				{ or: [{ status: { eq: 'paid' } }, { settled: { eq: true } }] }
			)
		).toBe(true);
		expect(matchesLock({ settled: true }, { not: { settled: { eq: true } } })).toBe(false);
		expect(matchesLock({ count: 3 }, { count: { in: [1, 3] } })).toBe(true);
		expect(matchesLock({ count: 3 }, { not: { count: { in: [1, 3] } } })).toBe(false);
	});
});
