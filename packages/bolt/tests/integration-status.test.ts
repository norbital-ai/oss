// An integration instance's status (§4.5): the host's answer decoded at the trust boundary and the state wording every
// provider's frame shares. The pairing itself is the host's; what is testable here is that the shell cannot be misled
// by a malformed answer and never words a retry as a failure.
import { describe, expect, it } from '@effect/vitest';
import { decodeStatus, localText, type InstanceStatus } from '../src/protocol/instance-status.ts';
import { statusLabel, driverLabel } from '../src/shell/integration/setup.ts';

const t = (k: string) => k;
const status = (over: Partial<InstanceStatus>): InstanceStatus => ({
	instance: 'c',
	integration: 'whatsapp',
	driver: 'whatsapp',
	state: 'unpaired',
	stored: false,
	...over
});

describe('a host answer, decoded', () => {
	it('keeps what the provider published and names the instance it is', () => {
		const c = decodeStatus({
			instance: 'field_ops_whatsapp',
			integration: 'whatsapp',
			driver: 'whatsapp',
			state: 'pairing',
			stored: true,
			pairing: { kind: 'qr', value: '2@abc,DEF+ghi==', expiresAt: '2026-09-29T12:00:00.000Z' },
			account: '+65 9123'
		});
		expect(c).toMatchObject({
			instance: 'field_ops_whatsapp',
			integration: 'whatsapp',
			driver: 'whatsapp',
			state: 'pairing',
			stored: true,
			account: '+65 9123',
			pairing: { kind: 'qr', value: '2@abc,DEF+ghi==', expiresAt: '2026-09-29T12:00:00.000Z' }
		});
	});

	it('refuses an answer it cannot read, rather than inventing a state', () => {
		// an unknown state, a non-object, no instance, an unknown driver, a pairing of a shape no provider publishes
		expect(
			decodeStatus({ instance: 'c', driver: 'whatsapp', state: 'definitely-connected' })
		).toBeNull();
		expect(decodeStatus('connected')).toBeNull();
		expect(decodeStatus({ driver: 'whatsapp', state: 'connected' })).toBeNull();
		expect(decodeStatus({ instance: 'c', driver: 'pigeon', state: 'connected' })).toBeNull();
		expect(
			decodeStatus({
				instance: 'c',
				driver: 'whatsapp',
				state: 'pairing',
				pairing: { kind: 'telepathy', value: 'x' }
			})?.pairing
		).toBeNull();
		expect(decodeStatus({})).toBeNull();
	});

	it('defaults `stored` to false, so an answer that omits it never reads as paired', () => {
		expect(decodeStatus({ instance: 'c', driver: 'telegram', state: 'connected' })?.stored).toBe(
			false
		);
	});

	it('decodes localized setup text and picks it by locale, English when a locale has none', () => {
		const c = decodeStatus({
			instance: 'a',
			driver: 'whatsapp',
			state: 'unpaired',
			providers: [
				{
					id: 'p',
					label: { en: 'Official', zh: '官方' },
					name: 'Provider',
					description: { en: 'Sync messages', zh: '同步消息' },
					icon: 'lucide:mail',
					setup: {
						kind: 'form',
						steps: [{ text: { en: 'Paste it' } }, { text: 7 }],
						fields: [{ name: 'k', label: { en: 'Key', zh: '密钥' }, hint: 'plain' }]
					}
				}
			],
			test: { to: { name: 'to', label: 'To' } }
		})!;
		const p = c.providers![0]!;
		expect(p).toMatchObject({
			name: 'Provider',
			description: { en: 'Sync messages', zh: '同步消息' },
			icon: 'lucide:mail'
		});
		expect(localText(p.label, 'zh-CN')).toBe('官方');
		expect(localText(p.setup.steps[0]!.text, 'zh')).toBe('Paste it');
		expect(p.setup.steps).toHaveLength(1);
		expect(localText(p.setup.fields![0]!.label, 'en')).toBe('Key');
		expect(c.test).toEqual({ to: { name: 'to', label: 'To' } });
	});
});

describe('how a state reads', () => {
	it('presents an automatic retry as progress, not a failure', () => {
		expect(statusLabel(status({ state: 'reconnecting', stored: true }), t)).toBe('Reconnecting');
		expect(statusLabel(status({ state: 'connecting', stored: true }), t)).toBe('Connecting');
	});

	it('reserves the alarm for the one terminal state', () => {
		expect(statusLabel(status({ state: 'error' }), t)).toBe('Needs attention');
	});

	it('distinguishes "never paired" from "paired but not open", and says who it is connected as', () => {
		expect(statusLabel(null, t)).toBe('Asking the host…');
		expect(statusLabel(status({}), t)).toBe('Not paired');
		expect(statusLabel(status({ stored: true }), t)).toBe('Paired, not connected');
		expect(statusLabel(status({ state: 'connected', stored: true, account: '+65abc' }), t)).toBe(
			'Connected as +65abc'
		);
	});
});

describe('an instance and its driver, named', () => {
	it('names driver kinds independently of the provider chosen for an account', () => {
		expect(driverLabel('whatsapp')).toBe('WhatsApp');
		expect(driverLabel('http')).toBe('HTTP');
		expect(driverLabel('sqlserver')).toBe('SQL Server');
		expect(driverLabel('calendar')).toBe('Calendar');
	});
});
