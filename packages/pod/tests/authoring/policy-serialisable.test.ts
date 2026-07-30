import { describe, expect, it } from 'vitest';
import { definePolicy } from '../../src/lib/authoring/policies/policies.js';

/**
 * A policy is stored as jsonb and round-tripped through the manifest. A function-valued `RAW` does not
 * survive that, and the grant then lands with empty conditions — which the guard reads as
 * unconditional. A narrowing that inverts into a widening is refused where it is written.
 */
describe('policy conditions must survive storage', () => {
	const base = { name: 'Field agent' } as const;

	it('refuses a RAW callback, naming where it is', () => {
		expect(() =>
			definePolicy({
				...base,
				grants: [
					{ collection: 'quotes', action: 'read', where: { RAW: () => 1 } }
				] as never
			})
		).toThrow(/uses a function at where\.RAW/);
	});

	it('refuses one nested inside AND, not just at the top level', () => {
		expect(() =>
			definePolicy({
				...base,
				grants: [
					{ collection: 'quotes', action: 'read', where: { AND: [{ RAW: () => 1 }] } }
				] as never
			})
		).toThrow(/where\.AND\[0\]\.RAW/);
	});

	it('accepts $sql, which is a string and survives', () => {
		expect(() =>
			definePolicy({
				...base,
				grants: [
					{
						collection: 'quotes',
						action: 'read',
						where: { $sql: '"owner_id" = ${requestor.norbital_id}' }
					}
				] as never
			})
		).not.toThrow();
	});

	it('accepts an ordinary field condition with a scope placeholder', () => {
		expect(() =>
			definePolicy({
				...base,
				grants: [
					{
						collection: 'quotes',
						action: 'read',
						where: { owner_id: { eq: '${requestor.norbital_id}' } }
					}
				] as never
			})
		).not.toThrow();
	});
});
