// A channel's connection (rule 61): the host's answer decoded at the trust boundary and the state wording every
// provider's frame shares. The pairing itself is the host's; what is testable here is that the shell cannot be misled
// by a malformed answer and never words a retry as a failure.
import { describe, expect, it } from 'vitest';
import { connection, decodeConnection } from '../src/engine/channels/connection.ts';
import { channelLabel, connectionLabel, transportLabel } from '../src/shell/channels/connect.ts';

const t = (k: string) => k;

describe('a host answer, decoded', () => {
	it('keeps what the provider published and names the channel it was asked for', () => {
		const c = decodeConnection('field_ops_whatsapp', {
			channel: 'field_ops_whatsapp', transport: 'whatsapp', state: 'pairing', stored: true,
			pairing: { kind: 'qr', value: '2@abc,DEF+ghi==', expiresAt: '2026-09-29T12:00:00.000Z' }
		});
		expect(c).toMatchObject({
			channel: 'field_ops_whatsapp', transport: 'whatsapp', state: 'pairing', stored: true,
			pairing: { kind: 'qr', value: '2@abc,DEF+ghi==', expiresAt: '2026-09-29T12:00:00.000Z' }
		});
	});

	it('refuses an answer it cannot read, rather than inventing a state', () => {
		// an unknown state, a non-object, a pairing of a shape no provider publishes
		expect(decodeConnection('c', { state: 'definitely-connected' })).toBeNull();
		expect(decodeConnection('c', 'connected')).toBeNull();
		expect(decodeConnection('c', { state: 'pairing', pairing: { kind: 'telepathy', value: 'x' } })?.pairing).toBeNull();
		expect(decodeConnection('c', {})).toBeNull();
	});

	it('defaults `stored` to false, so an answer that omits it never reads as paired', () => {
		expect(decodeConnection('c', { state: 'connected' })?.stored).toBe(false);
		expect(connection('c', 'telegram', 'unpaired').stored).toBe(false);
		expect(connection('c', 'telegram', 'connected', { stored: true }).stored).toBe(true);
	});
});

describe('how a state reads', () => {
	it('presents an automatic retry as progress, not a failure', () => {
		expect(connectionLabel({ channel: 'c', transport: 'whatsapp', state: 'reconnecting', stored: true }, t)).toBe('Reconnecting');
		expect(connectionLabel({ channel: 'c', transport: 'whatsapp', state: 'connecting', stored: true }, t)).toBe('Connecting');
	});

	it('reserves the alarm for the one terminal state', () => {
		expect(connectionLabel({ channel: 'c', transport: 'whatsapp', state: 'error', stored: false }, t)).toBe('Needs attention');
	});

	it('distinguishes "never paired" from "paired but not open", and says who it is connected as', () => {
		expect(connectionLabel(null, t)).toBe('Asking the host…');
		expect(connectionLabel({ channel: 'c', transport: 'whatsapp', state: 'unpaired', stored: false }, t)).toBe('Not paired');
		expect(connectionLabel({ channel: 'c', transport: 'whatsapp', state: 'unpaired', stored: true }, t)).toBe('Paired, not connected');
		expect(connectionLabel({ channel: 'c', transport: 'whatsapp', state: 'connected', stored: true, pairedAs: '+65abc' }, t))
			.toBe('Connected as +65abc');
	});
});

describe('a channel and its transport, named', () => {
	it('uses the catalog label, else the name humanized with brand casing; a transport is its brand', () => {
		const catalog = (k: string) => k === 'channels.customer_mail.label' ? 'Customer email' : k;
		expect(channelLabel('customer_mail', catalog)).toBe('Customer email');
		expect(channelLabel('site_whatsapp', t)).toBe('Site WhatsApp');
		expect(channelLabel('whatsapp', t)).toBe('WhatsApp');
		expect(channelLabel('field-ops_imap', t)).toBe('Field ops IMAP');
		expect(transportLabel('whatsapp')).toBe('WhatsApp');
		expect(transportLabel('custom')).toBe('Custom');
	});
});
