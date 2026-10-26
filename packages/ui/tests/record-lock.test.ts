import { describe, expect, it } from 'vitest';
import { matchesLock } from '../src/record/lock.js';

describe('a record lock declared on a model', () => {
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
		expect(matchesLock({ count: 3 }, { count: { nin: [1, 3] } })).toBe(false);
	});
});
