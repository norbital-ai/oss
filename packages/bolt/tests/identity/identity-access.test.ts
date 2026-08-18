import { describe, expect, it } from 'vitest';
import { decide } from '../../src/runtime/access/access-control.js';

const subject = { userId: 'u1', tenantId: 't1', roles: ['member'], teams: [] };
describe('Identity and AccessControl owners', () => {
	it('applies explicit deny before allow', () => {
		const policies = [
			{
				name: 'allow',
				effect: 'allow' as const,
				actions: ['read'],
				roles: ['member'],
				apps: ['people']
			},
			{
				name: 'deny',
				effect: 'deny' as const,
				actions: ['read'],
				roles: ['member'],
				apps: ['people']
			}
		];
		expect(decide(policies, subject, 'read', 'people')).toEqual({
			allowed: false,
			reason: 'explicit deny'
		});
	});
	it('defaults to deny when no policy matches', () => {
		expect(decide([], subject, 'read', 'people')).toEqual({
			allowed: false,
			reason: 'no matching allow policy'
		});
	});
	it('refuses an unknown agent name and allows a declared workspace agent', () => {
		const admin = { userId: 'u1', tenantId: 't1', roles: ['admin'], teams: [] };
		const policies = [
			{
				name: 'admin-agent',
				effect: 'allow' as const,
				actions: ['agent'],
				roles: ['admin'],
				apps: ['helper']
			}
		];
		expect(decide(policies, admin, 'agent', 'workspace')).toEqual({
			allowed: false,
			reason: 'no matching allow policy'
		});
		expect(decide(policies, admin, 'agent', 'helper')).toEqual({
			allowed: true,
			reason: 'explicit allow'
		});
	});
});
