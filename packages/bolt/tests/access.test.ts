import { describe, expect, it } from 'vitest';
import { policy } from '../src/index.ts';
import { applicant, salesRep } from './types/access.ts';

describe('next access', () => {
	it('policy returns its literal with approval callbacks on each write grant', () => {
		expect(policy(salesRep)).toBe(salesRep);
		expect(salesRep.grants.orders).toMatchObject({
			create: { approval: expect.any(Function) },
			update: { approval: expect.any(Function) },
			delete: { approval: expect.any(Function) }
		});
		expect(applicant.limits.register).toEqual({ rate: '10/h', per: 'ip' });
	});
});
