import { describe, expect, it } from 'vitest';
import { assertChannelTransportsAreSupported } from '../../src/lib/authoring/channels/channels.js';
import { consoleMessaging, messagingProviders } from '../../src/lib/host/facilities.js';

/**
 * A channel names a wire only the host can hold open, and the two halves are matched by exact string
 * at delivery — so a wrong name produced no error and no record, only a channel that never carried
 * anything. Startup is where that becomes visible.
 */
describe('channel transports', () => {
	const channel = (transport: string) => ({ transport, policy: 'sales_rep' });

	it('accepts a channel whose transport the host supplies', () => {
		expect(() =>
			assertChannelTransportsAreSupported(
				{ sales_desk: channel('telegram') },
				new Set(['telegram', 'whatsapp'])
			)
		).not.toThrow();
	});

	it('refuses a transport the host does not supply, naming the channel and the alternatives', () => {
		expect(() =>
			assertChannelTransportsAreSupported(
				{ sales_desk: channel('telgram') },
				new Set(['whatsapp', 'telegram'])
			)
		).toThrow(/Channel "sales_desk".*"telgram".*Available transports: telegram, whatsapp\./s);
	});

	it('says so plainly when the host supplies no transports at all', () => {
		expect(() =>
			assertChannelTransportsAreSupported({ sales_desk: channel('telegram') }, new Set())
		).toThrow(/This host supplies no transports/);
	});

	/** A workspace with no channels must not be gated on a facility it never asked for. */
	it('leaves a workspace with no channels alone', () => {
		expect(() => assertChannelTransportsAreSupported({}, new Set())).not.toThrow();
	});

	it('names every unsupported channel, not just the first', () => {
		const failure = (() => {
			try {
				assertChannelTransportsAreSupported(
					{ sales_desk: channel('telegram'), support: channel('sms') },
					new Set(['whatsapp'])
				);
				return null;
			} catch (cause) {
				return cause as Error;
			}
		})();
		expect(failure?.message).toMatch(/sales_desk/);
		expect(failure?.message).toMatch(/support/);
	});

	/**
	 * The check is only worth having if a host's transports are reachable, and they cross the isolate
	 * boundary as a method call rather than a record — a proxy that forwards method calls cannot carry
	 * a data field, let alone a record of functions.
	 */
	it('reads the host transports back through the binding that crosses the isolate', async () => {
		const binding = messagingProviders({
			transports: [{ transport: 'telegram', send: async () => ({ sent: true }) }]
		});
		expect(await binding.listTransports()).toEqual(['telegram']);
		expect(await binding.sendVia('telegram', { conversationId: '42', text: 'hi' })).toEqual({
			sent: true
		});
		expect(await binding.sendVia('sms', { conversationId: '42', text: 'hi' })).toEqual({
			sent: false,
			reason: 'No transport named sms'
		});
	});

	/** `pod dev` stands in for the transports the workspace declares, so the gate stays passable. */
	it('accepts what the development console messaging binding stands in for', async () => {
		const binding = consoleMessaging({ channels: ['email'], transports: ['telegram'] });
		// Channels and transports are separate lists: `email` delivers to a user, `telegram` carries a
		// conversation, and neither satisfies the other.
		expect(binding.channels).toEqual(['email']);
		const transports = new Set(await binding.listTransports());
		expect(() =>
			assertChannelTransportsAreSupported({ sales_desk: channel('telegram') }, transports)
		).not.toThrow();
	});
});
