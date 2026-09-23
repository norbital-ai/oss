import { expect, it } from 'vitest';
import { parseInboundEnvelope } from '../src/client/ui/agent/inbound-message.js';

it('unwraps the envoy envelope into sender, time, invocation and body', () => {
	const envelope = parseInboundEnvelope(
		[
			'INBOUND MESSAGE',
			'[2026-09-21T06:02:00.000Z] Dion · direct · chat 6591234567@s.whatsapp.net · message 3A27EB4E6BCC6DE9F441 · sender 6591234567@s.whatsapp.net',
			'Okay can u check on what jobs we have that are still open'
		].join('\n')
	);
	expect(envelope).toEqual({
		sender: 'Dion',
		sentAt: '2026-09-21T06:02:00.000Z',
		invocation: 'direct',
		messageId: '3A27EB4E6BCC6DE9F441',
		body: 'Okay can u check on what jobs we have that are still open'
	});
});

it('drops the registered-account line and keeps the words', () => {
	const envelope = parseInboundEnvelope(
		[
			'INBOUND MESSAGE',
			'[2026-09-21T06:00:45.000Z] ~ YK - BCA · direct · chat 6598765432@s.whatsapp.net · message 3A9788E4B5CAA66028CC',
			'[registered account: Yu Kiat Tan · not an administrator · team Contractor]',
			'Site photos attached.'
		].join('\n')
	);
	// The registered account is attribution the metadata line already carries, not message text.
	expect(envelope?.body).toBe('Site photos attached.');
	expect(envelope?.sender).toBe('~ YK - BCA');
});

it('leaves a message that is not the runtime envelope alone', () => {
	expect(parseInboundEnvelope('INBOUND MESSAGE\njust some words')).toBeNull();
	expect(parseInboundEnvelope('Okay can u check on what jobs we have')).toBeNull();
	expect(parseInboundEnvelope('')).toBeNull();
});
