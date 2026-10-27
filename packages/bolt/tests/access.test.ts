import { describe, expect, it } from 'vitest';
import { policy } from '../src/index.ts';
import { applicant, salesRep } from './types/access.ts';

describe('next access', () => {
	it('policy returns its literal with a check callback on each write grant', () => {
		expect(policy(salesRep)).toBe(salesRep);
		expect(salesRep.grants.orders).toMatchObject({
			create: { check: expect.any(Function) },
			update: { check: expect.any(Function) },
			delete: { check: expect.any(Function) }
		});
		expect(applicant.limits.register).toEqual({ rate: '10/h', per: 'ip' });
	});
});
