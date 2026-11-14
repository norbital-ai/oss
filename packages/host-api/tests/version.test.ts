import { describe, expect, it } from 'vitest';
import { supports } from '../src/version.ts';

describe('a host serves a HOST_API range', () => {
	it('admits both ends and refuses outside them or a fraction', () => {
		const range = { from: 19, to: 20 };
		expect([18, 19, 20, 21, 19.5].map((version) => supports(range, version))).toEqual([
			false,
			true,
			true,
			false,
			false
		]);
	});
});
