import { describe, expect, it } from 'vitest';
import { SeatCensusSchema, UserRoleSchema } from '@norbital-ai/platform-utils/system/types';

/**
 * The seat model is a billing contract, so the shape is pinned here rather than only exercised
 * incidentally through the runtime. A silent change to either the tier set or the census shape would
 * mis-bill every tenant, and would otherwise only surface as a wrong invoice.
 */
describe('seat tiers', () => {
	it('is exactly admin, advanced, basic', () => {
		expect(UserRoleSchema.options).toEqual(['admin', 'advanced', 'basic']);
	});

	it('rejects the retired `member` role', () => {
		expect(UserRoleSchema.safeParse('member').success).toBe(false);
	});

	it('describes a census as one non-negative integer per tier', () => {
		expect(SeatCensusSchema.parse({ admin: 1, advanced: 0, basic: 12 })).toEqual({
			admin: 1,
			advanced: 0,
			basic: 12
		});
		expect(SeatCensusSchema.safeParse({ admin: -1, advanced: 0, basic: 0 }).success).toBe(false);
		expect(SeatCensusSchema.safeParse({ admin: 1.5, advanced: 0, basic: 0 }).success).toBe(false);
		// A partial census would silently bill zero for the missing tier.
		expect(SeatCensusSchema.safeParse({ admin: 1 }).success).toBe(false);
	});

	it('covers every role, so no tier can exist without a seat line', () => {
		const census = SeatCensusSchema.parse({ admin: 0, advanced: 0, basic: 0 });
		expect(Object.keys(census).sort()).toEqual([...UserRoleSchema.options].sort());
	});
});
