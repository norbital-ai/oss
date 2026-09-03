import { describe, expect, it } from 'vitest';
import { AccessDenied } from '../src/runtime/access/invocation.js';

describe('AccessDenied', () => {
	it('exposes the authorization sentence on message, not only on reason', () => {
		const denied = new AccessDenied({
			action: 'create',
			resource: 'notes',
			reason: 'write authorization note-quota:notes:create:authorize refused the prepared record'
		});
		expect(denied).toBeInstanceOf(Error);
		expect(denied.reason).toContain('authorization');
		expect(denied.message).toContain('authorization');
		expect(denied.message).toBe(denied.reason);
	});
});
