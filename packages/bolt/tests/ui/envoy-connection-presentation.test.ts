import { describe, expect, it } from 'vitest';
import {
	connectionIsRecovering,
	connectionIsTerminalError,
	connectionLabel
} from '../../src/client/ui/org/envoy-connection-presentation.js';

describe('envoy transport connection presentation', () => {
	it('presents an automatic retry as progress rather than an error', () => {
		const connection = {
			state: 'connecting' as const,
			stored: true,
			retrying: true
		};

		expect(connectionLabel(connection, 'whatsapp')).toBe('Reconnecting');
		expect(connectionIsRecovering(connection)).toBe(true);
		expect(connectionIsTerminalError(connection)).toBe(false);
	});

	it('reserves the terminal presentation for an unrecoverable error', () => {
		const connection = { state: 'error' as const, stored: false };

		expect(connectionLabel(connection, 'whatsapp')).toBe('Needs attention');
		expect(connectionIsRecovering(connection)).toBe(false);
		expect(connectionIsTerminalError(connection)).toBe(true);
	});
});
