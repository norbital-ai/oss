import { describe, expect, it } from 'vitest';
import { decodeWireValue, encodeWireValue } from '@norbital-ai/platform-utils/runtime/wire';
import type {
	HostMessagingBinding,
	RuntimeFacilityBindings
} from '@norbital-ai/platform-utils/runtime/binding';
import { consoleMessaging, messagingProviders } from '../../src/host/facilities.js';
import { localFileStorage } from '../../src/host/file-storage.js';
import { googleMaps } from '../../src/host/maps.js';
import { assertNotificationChannelSupport } from '../../src/server/notification-outbox.server.js';

/**
 * A facility binding may only declare methods.
 *
 * A data field on a binding is a Core-only defect that no standalone test can see: `pod start` hands
 * the tenant the real object, so reading the field works, and the type checks out on both sides.
 * Inside an isolate the same binding is a method-only projection, whose `get` trap
 * answers *every* property with a call forwarder — so the field is a function there, and a value
 * that is not a plain structure does not survive the boundary's structured clone at all.
 *
 * `messaging.channels` was exactly that. `hook-api.server.ts` read it inside the isolate and passed
 * a function where `assertNotificationChannelSupport` expected an array, so `new Set(fn)` threw
 * `TypeError: function is not iterable` — every external notification failed under Core with an
 * error naming nothing that would lead anyone to the cause — while `invitation.server.ts` read
 * `channels[0] ?? 'email'` off the same function and silently addressed a channel the host may
 * never have advertised. It is `listChannels()` now.
 */

/**
 * The rule, stated to the type checker.
 *
 * `FacilityDataFields` is the union of every non-method property declared across every facility
 * binding, and it is `never` exactly when the rule holds. Reintroduce a data field and this stops
 * compiling, naming the offending property — `tsgo -p tests/tsconfig.json` runs in `pnpm lint`, so
 * the failure arrives before any test does, and it covers facilities no test here constructs.
 */
type FunctionMember = (...args: never[]) => unknown;
type DataFieldsOf<T> = {
	[K in keyof T]-?: NonNullable<T[K]> extends FunctionMember ? never : K;
}[keyof T];
type FacilityDataFields = {
	[K in keyof RuntimeFacilityBindings]-?: DataFieldsOf<NonNullable<RuntimeFacilityBindings[K]>>;
}[keyof RuntimeFacilityBindings];

const noFacilityCarriesADataField: [FacilityDataFields] extends [never]
	? true
	: FacilityDataFields = true;

/**
 * The host half of a hosted binding call, standing in for Core: decode the arguments, invoke the
 * real binding, encode the result. `structuredClone` is the point — it is what the isolate boundary
 * does to a return value, and it is what a function (or a record of them) does not survive.
 */
function facilityProxy<T>(
	name: string,
	call: (facility: string, method: string, args: readonly unknown[]) => Promise<unknown>
): T {
	return new Proxy({} as Record<string, unknown>, {
		get(_target, method: string) {
			return (...args: unknown[]) => call(name, method, args).then(decodeWireValue);
		}
	}) as T;
}

function hostDispatcher(bindings: Record<string, unknown>) {
	return async (facility: string, method: string, args: readonly unknown[]): Promise<unknown> => {
		const target = bindings[facility] as Record<string, unknown> | undefined;
		if (!target) throw new Error(`No ${facility} binding`);
		const member = target[method];
		if (typeof member !== 'function') {
			throw new Error(`${facility}.${method} is not callable across the isolate boundary`);
		}
		const decoded = args.map(decodeWireValue);
		const result: unknown = await (member as (...a: unknown[]) => unknown).apply(target, decoded);
		return structuredClone(encodeWireValue(result));
	};
}

describe('facility bindings across the isolate boundary', () => {
	/**
	 * Every own property of every binding Pod constructs must be a function. This is the check that
	 * fails the moment a data field is reintroduced anywhere on `RuntimeFacilityBindings`, on any
	 * facility, without waiting for a call site to read it.
	 */
	it('exposes methods only, on every binding a host can build here', async () => {
		const built: Record<string, object> = {
			messaging: messagingProviders({
				channels: [{ channel: 'email', send: async () => ({ sent: true }) }],
				transports: [{ transport: 'telegram', send: async () => ({ sent: true }) }]
			}),
			consoleMessaging: consoleMessaging({ channels: ['email'], transports: ['telegram'] }),
			fileStorage: localFileStorage({ directory: '.norbital/storage-shape-probe' }),
			maps: googleMaps({ apiKey: 'not-called' })
		};
		for (const [name, binding] of Object.entries(built)) {
			const fields = Object.entries(binding)
				.filter(([, value]) => typeof value !== 'function')
				.map(([key]) => key);
			expect(
				fields,
				`${name} carries data field(s) that arrive as functions inside a hosted isolate`
			).toEqual([]);
		}
	});

	/**
	 * The same guarantee from the isolate's side: reached through the real proxy, the messaging
	 * binding still answers with channel names, and channel validation still accepts and refuses the
	 * right things. With `channels` as a field this threw `TypeError: function is not iterable`.
	 */
	it('validates notification channels when messaging is reached through a method-only proxy', async () => {
		const call = hostDispatcher({
			messaging: messagingProviders({
				channels: [
					{ channel: 'email', send: async () => ({ sent: true }) },
					{ channel: 'sms', send: async () => ({ sent: true }) }
				]
			})
		});
		const messaging = facilityProxy<HostMessagingBinding>('messaging', call);

		const supported = await messaging.listChannels();
		expect(supported).toEqual(['email', 'sms']);
		expect(() => assertNotificationChannelSupport(['email'], supported)).not.toThrow();
		expect(() => assertNotificationChannelSupport(['telegram'], supported)).toThrow(
			/does not provide notification channel: telegram/
		);
	});

	/** A data field read through the proxy is a function — the defect this suite exists to prevent. */
	it('answers a property that is not a method with a call forwarder, silently', async () => {
		const withField = {
			listChannels: async () => ['email'],
			channels: ['email'],
			send: async () => ({ sent: true }),
			listTransports: async () => [],
			sendVia: async () => ({ sent: false })
		};
		const proxied = facilityProxy<Record<string, unknown>>(
			'messaging',
			hostDispatcher({ messaging: withField })
		);
		expect(typeof withField.channels).toBe('object');
		expect(typeof proxied.channels).toBe('function');
		// Nothing warns; the value is simply the wrong kind on the far side.
		expect(() => new Set(proxied.channels as Iterable<string>)).toThrow(TypeError);
	});

	/**
	 * Every facility, including the ones nothing here can construct. The assertion is the type above;
	 * this only makes its failure visible in a test run as well as in `pnpm lint`.
	 */
	it('declares no data field on any facility binding', () => {
		expect(noFacilityCarriesADataField).toBe(true);
	});
});

/**
 * Hosts assemble `RuntimeFacilityBindings` for `pod start` and for Core isolate injection.
 * They must offer the same facilities. The type is the guard: a facility added to
 * `RuntimeFacilityBindings` and not named here should not compile.
 */
describe('both binding assemblies offer every facility', () => {
	it('names every optional facility, so a new one cannot be added to only one assembler', () => {
		// Fails to compile if `RuntimeFacilityBindings` gains a member absent from this list.
		const covered: Record<Exclude<keyof RuntimeFacilityBindings, 'db'>, true> = {
			fileStorage: true,
			ai: true,
			messaging: true,
			maps: true,
			agentTools: true
		};
		expect(Object.keys(covered).sort()).toEqual([
			'agentTools',
			'ai',
			'fileStorage',
			'maps',
			'messaging'
		]);
	});

	it('does not expose a runtimeLifecycle facility', () => {
		type RuntimeLifecycleKey = Extract<keyof RuntimeFacilityBindings, 'runtimeLifecycle'>;
		const absent: [RuntimeLifecycleKey] extends [never] ? true : RuntimeLifecycleKey = true;
		expect(absent).toBe(true);
	});
});

