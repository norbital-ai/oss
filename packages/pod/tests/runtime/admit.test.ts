import { describe, expect, it } from 'vitest';
import {
	ADMIT_DEADLINE_HEADER,
	ADMIT_TIMEOUT_HEADER,
	admitHeaders,
	currentAdmit,
	parseAdmitHeaders,
	remainingMs,
	runWithAdmit,
	startAdmit
} from '../../src/server/admit.js';

describe('admit', () => {
	it('parses host timeout and deadline headers and ignores a missing or invalid pair', () => {
		const admit = startAdmit(2_000);
		const headers = new Headers(admitHeaders(admit));
		expect(parseAdmitHeaders(headers)).toEqual(admit);

		expect(parseAdmitHeaders(new Headers())).toBeNull();
		expect(
			parseAdmitHeaders(
				new Headers({
					[ADMIT_TIMEOUT_HEADER]: '2000',
					[ADMIT_DEADLINE_HEADER]: 'not-a-number'
				})
			)
		).toBeNull();
		expect(
			parseAdmitHeaders(
				new Headers({
					[ADMIT_TIMEOUT_HEADER]: '0',
					[ADMIT_DEADLINE_HEADER]: String(Date.now() + 1)
				})
			)
		).toBeNull();
	});

	it('exposes remainingMs only inside runWithAdmit', () => {
		expect(remainingMs()).toBeNull();
		expect(currentAdmit()).toBeNull();

		const admit = startAdmit(5_000);
		runWithAdmit(admit, () => {
			expect(currentAdmit()).toEqual(admit);
			const remaining = remainingMs();
			expect(remaining).not.toBeNull();
			expect(remaining).toBeLessThanOrEqual(5_000);
			expect(remaining).toBeGreaterThan(4_000);
		});

		expect(remainingMs()).toBeNull();
	});

	it('treats a null admit as no budget rather than inventing one', () => {
		expect(runWithAdmit(null, () => remainingMs())).toBeNull();
	});

	it('rejects a non-positive host timeout', () => {
		expect(() => startAdmit(0)).toThrow(/positive integer/);
		expect(() => startAdmit(1.5)).toThrow(/positive integer/);
	});
});
