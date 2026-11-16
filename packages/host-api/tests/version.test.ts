import { describe, expect, it } from 'vitest';
import { HOST_API_VERSION, supports } from '../src/version.ts';

describe('a host serves the current HOST_API', () => {
	it('refuses other versions and invalid numbers', () => {
		expect(supports(HOST_API_VERSION)).toBe(true);
		for (const version of [HOST_API_VERSION - 1, HOST_API_VERSION + 1, 0, 19.5, NaN, Infinity])
			expect(supports(version)).toBe(false);
	});
});
