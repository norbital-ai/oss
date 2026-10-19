import { describe, expect, it } from 'vitest';
import { policy } from '../src/index.ts';
import { applicant, salesRep } from './types/access.ts';

describe('next access', () => {
	it('policy returns its literal: grants, optional approval fallbacks and limits are data', () => {
		const spec = {
			description: 'x',
			grants: { orders: { read: true, approval: { update: { steps: [['Finance']] } } } }
		} as const;
		expect(policy(spec)).toBe(spec);
		expect(salesRep.grants.orders.approval.update.map((route) => route.steps)).toEqual([
			[['Sales'], ['Finance']],
			[['Finance', 'Sales']]
		]);
		expect(applicant.limits.register).toEqual({ rate: '10/h', per: 'ip' });
	});
});
