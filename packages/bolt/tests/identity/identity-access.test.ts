import { describe, expect, it } from 'vitest';
import { decidePolicies } from '../../src/runtime/access/access-control.js';

const subject = { userId: 'u1', tenantId: 't1', policies: [], teamPath: ['member'] };

/**
 * The policies the subject's team declares, which `decide` now takes rather than derives.
 *
 * A policy used to name the roles that could match it, so a subject and a policy each carried half
 * of the same fact and either could be edited without the other. The set is passed in because it is
 * resolved once per invocation, from `+teams.ts`, and every decision in that invocation is answered
 * against the same one.
 */
const held = (...names: ReadonlyArray<string>) => new Set(names);

describe('Identity and AccessControl owners', () => {
	it('applies explicit deny before allow', () => {
		const policies = [
			{
				name: 'allow',
				effect: 'allow' as const,
				actions: ['read'],
				capabilities: { apps: ['people'] }
			},
			{
				name: 'deny',
				effect: 'deny' as const,
				actions: ['read'],
				capabilities: { apps: ['people'] }
			}
		];
		expect(decidePolicies(policies, subject, 'read', 'people', held('allow', 'deny'))).toEqual({
			allowed: false,
			reason: 'explicit deny'
		});
	});
	it('defaults to deny when no policy matches', () => {
		expect(decidePolicies([], subject, 'read', 'people', held())).toEqual({
			allowed: false,
			reason: 'no matching allow policy'
		});
	});
	it('leaves authored-resource classification to the access service', () => {
		const administrator = { ...subject, admin: true };
		expect(decidePolicies([], administrator, 'read', 'people', held())).toEqual({
			allowed: false,
			reason: 'no matching allow policy'
		});
	});
	/**
	 * A declared policy the subject's team does not hold is not a policy for them.
	 *
	 * This is the case `roles` used to answer by comparing two lists at decision time. Holding is now
	 * the only selector, so a release may declare a policy nobody holds without granting anything.
	 */
	it('ignores a policy the team does not hold', () => {
		const policies = [
			{
				name: 'allow',
				effect: 'allow' as const,
				actions: ['read'],
				capabilities: { apps: ['people'] }
			}
		];
		expect(decidePolicies(policies, subject, 'read', 'people', held())).toEqual({
			allowed: false,
			reason: 'no matching allow policy'
		});
	});
	it('refuses an unknown agent name and allows a declared workspace agent', () => {
		const admin = { userId: 'u1', tenantId: 't1', policies: [], teamPath: ['admin'] };
		const policies = [
			{
				name: 'admin-agent',
				effect: 'allow' as const,
				actions: ['agent'],
				capabilities: { apps: ['helper'] }
			}
		];
		expect(decidePolicies(policies, admin, 'agent', 'workspace', held('admin-agent'))).toEqual({
			allowed: false,
			reason: 'no matching allow policy'
		});
		expect(decidePolicies(policies, admin, 'agent', 'helper', held('admin-agent'))).toEqual({
			allowed: true,
			reason: 'explicit allow'
		});
	});
});
