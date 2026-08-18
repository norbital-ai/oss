import { identityFailureMessage } from '../../src/client/ui/identity/i18n.js';
import { describe, expect, it } from 'vitest';

describe('Bolt identity copy', () => {
	it('maps host failure codes to the tenant-owned messages', () => {
		expect(identityFailureMessage('en', 'invalid-email')).toBe('Enter a valid email address.');
		expect(identityFailureMessage('en', 'invalid-code')).toBe('That code is not correct.');
		expect(identityFailureMessage('en', 'no-access')).toBe(
			'That email does not have access to this workspace.'
		);
		expect(identityFailureMessage('en', 'mint-failed')).toBe(
			'Something went wrong. Please try again.'
		);
	});
});
