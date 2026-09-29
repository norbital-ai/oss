// A channel's connection (rule 61): the host's answer decoded at the trust boundary, the one place a connect component
// is chosen, and the state wording every provider's frame shares. The pairing itself is the host's; what is testable here
// is that the shell cannot be misled by a malformed answer, cannot tell a system provider from a workspace's own, and
// never words a retry as a failure.
import { describe, expect, it } from 'vitest';
import { connection, decodeConnection } from '../src/engine/channels/connection.ts';
import { connectOf, connectionLabel, type ConnectLoader } from '../src/shell/channels/connect.ts';

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

describe('which connect component a channel gets', () => {
	const own = (async () => ({ default: (() => {}) as never })) as unknown as ConnectLoader;

	it('prefers the workspace\'s own file for its channel', async () => {
		expect(connectOf('field_ops_whatsapp', 'whatsapp', { field_ops_whatsapp: own })).toBe(own);
	});

	it("falls back to bolt's own for the channel's transport", () => {
		// a Slack or a WeChat channel nobody has written a component for yet
		expect(connectOf('field_ops_slack', 'slack', {})).toBeNull();
		expect(connectOf('c', 'whatsapp', {})).not.toBeNull();
		expect(connectOf('c', 'telegram', {})).not.toBeNull();
		expect(connectOf('c', 'email', {})).not.toBeNull();
	});

	it('answers a loader for every provider bolt ships, so none of them renders blank', async () => {
		for (const transport of ['whatsapp', 'telegram', 'email']) {
			const loader = connectOf('c', transport, {});
			expect(loader).not.toBeNull();
			expect(typeof (await loader!()).default).toBe('function');
		}
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
