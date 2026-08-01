import { describe, expect, it } from 'vitest';
import { assertNotificationChannelSupport } from '../../src/lib/server/notifications/channels.js';

describe('host notification channels', () => {
	it('accepts only channels advertised by the active host', () => {
		expect(() =>
			assertNotificationChannelSupport(['email', 'telegram'], ['telegram', 'email'])
		).not.toThrow();
		expect(() => assertNotificationChannelSupport(['email', 'sms'], ['email'])).toThrow(
			/The active host does not provide notification channel: sms/
		);
	});
});
