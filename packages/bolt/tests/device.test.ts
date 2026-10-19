import { afterEach, expect, it, vi } from '@effect/vitest';
import { Effect } from 'effect';
import {
	awaitDevice,
	resolveDevice,
	type DeviceApi,
	type NativePermission
} from '../src/page/device.ts';
import { deviceAccess } from '../src/shell/device-access.ts';
afterEach(() => vi.unstubAllGlobals());
it('prefers optional native Device, retains browser support and reports absence', () => {
	const browser: Geolocation = {
		getCurrentPosition: vi.fn(),
		watchPosition: vi.fn(() => 1),
		clearWatch: vi.fn()
	};
	const native: Geolocation = {
		getCurrentPosition: vi.fn(),
		watchPosition: vi.fn(() => 2),
		clearWatch: vi.fn()
	};
	vi.stubGlobal('navigator', { geolocation: browser });
	vi.stubGlobal('window', {});
	expect(resolveDevice().geolocation).toEqual({ source: 'browser', api: browser });
	expect(resolveDevice({ geolocation: { source: 'native', api: native } }).geolocation).toEqual({
		source: 'native',
		api: native
	});
	expect(resolveDevice({ geolocation: { source: 'browser', api: browser } }).geolocation?.api).toBe(
		browser
	);
	vi.stubGlobal('window', {});
	vi.stubGlobal('navigator', {});
	expect(resolveDevice()).toEqual({});
	vi.stubGlobal('navigator', undefined);
	vi.stubGlobal('window', undefined);
	expect(resolveDevice()).toEqual({});
});

const geolocation = (id: number): Geolocation => ({
	getCurrentPosition: vi.fn(),
	watchPosition: vi.fn(() => id),
	clearWatch: vi.fn()
});

it.effect(
	'uses the injected native permissions and background authorization without probing them during decoding',
	() =>
		Effect.gen(function* () {
			const background = {
				status: vi.fn(async () => ({ enabled: true, always: false })),
				openSettings: vi.fn(async () => undefined)
			};
			const camera: NativePermission = {
				status: vi.fn(async () => 'denied' as const),
				request: vi.fn(async () => 'denied' as const),
				openSettings: vi.fn(async () => undefined)
			};
			const notifications = {
				...camera,
				show: vi.fn(async () => undefined),
				onOpen: vi.fn(() => () => undefined)
			};
			const native: DeviceApi = {
				platform: 'ios',
				geolocation: { source: 'native', api: geolocation(2), background },
				notifications,
				camera,
				push: {
					register: vi.fn(async () => ({
						kind: 'apns' as const,
						endpoint: 'ab',
						keys: { topic: 't', environment: 'production' as const, teamId: 'T' }
					}))
				},
				notices: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
				navigation: { openExternal: vi.fn(async () => undefined) }
			};
			vi.stubGlobal('navigator', { geolocation: geolocation(1) });
			vi.stubGlobal('window', { boltDevice: Object.freeze(native) });
			const apis = resolveDevice();
			expect(apis.geolocation?.source).toBe('native');
			expect(apis.geolocation?.background).toBe(background);
			expect(apis).toMatchObject({
				platform: 'ios',
				notifications,
				camera,
				push: native.push,
				notices: native.notices,
				navigation: native.navigation
			});
			expect(background.status).not.toHaveBeenCalled();
			expect(notifications.status).not.toHaveBeenCalled();
			expect(native.push?.register).not.toHaveBeenCalled();
			const wall = deviceAccess(apis);
			expect(yield* wall.check('location:background')).toEqual({ state: 'denied', settings: true });
			expect(yield* wall.check('notifications')).toEqual({ state: 'denied', settings: true });
			yield* wall.openSettings('notifications');
			expect(notifications.openSettings).toHaveBeenCalledOnce();
		})
);

it('reads late injection and teardown on each call while an explicit override remains authoritative', () => {
	const browser = geolocation(1),
		native = geolocation(2),
		explicit = geolocation(3);
	const current = {};
	vi.stubGlobal('navigator', { geolocation: browser });
	vi.stubGlobal('window', current);
	expect(resolveDevice().geolocation?.api).toBe(browser);
	Object.defineProperty(current, 'boltDevice', {
		value: { geolocation: { source: 'native', api: native } },
		configurable: true
	});
	expect(resolveDevice().geolocation?.api).toBe(native);
	expect(resolveDevice({}).geolocation?.api).toBe(browser);
	const supplied: DeviceApi = { geolocation: { source: 'native', api: explicit } };
	expect(resolveDevice(supplied)).toBe(supplied);
	Reflect.deleteProperty(current, 'boltDevice');
	expect(resolveDevice().geolocation?.api).toBe(browser);
});

it('ignores malformed, inherited, accessor and parent-frame descriptors without borrowing capabilities', () => {
	const browser = geolocation(1),
		native = geolocation(2);
	vi.stubGlobal('navigator', { geolocation: browser });
	for (const value of [
		null,
		{ notifications: { status: () => Promise.resolve('granted') } },
		{ platform: 'watch' },
		{ push: { register: true } },
		{ notices: { start() {} } },
		{ geolocation: { source: 'other', api: native } },
		{ geolocation: { source: 'native', api: { getCurrentPosition() {} } } },
		{ geolocation: { source: 'native', api: native, background: { status: false } } }
	]) {
		vi.stubGlobal('window', { boltDevice: value });
		expect(resolveDevice()).toEqual({ geolocation: { source: 'browser', api: browser } });
	}
	const injected: DeviceApi = { geolocation: { source: 'native', api: native } };
	class InheritedFacilities {
		get boltDevice() {
			return injected;
		}
	}
	vi.stubGlobal('window', new InheritedFacilities());
	expect(resolveDevice().geolocation?.api).toBe(browser);
	const get = vi.fn(() => injected);
	const current = {};
	Object.defineProperty(current, 'boltDevice', { get });
	vi.stubGlobal('window', current);
	expect(resolveDevice().geolocation?.api).toBe(browser);
	expect(get).not.toHaveBeenCalled();
	vi.stubGlobal('window', { parent: { boltDevice: injected } });
	expect(resolveDevice().geolocation?.api).toBe(browser);
});

it.effect(
	'waits for asynchronous host installation before taking the native Device snapshot and propagates startup failure',
	() =>
		Effect.gen(function* () {
			const ready = Promise.withResolvers<void>();
			const current = { boltDeviceReady: ready.promise };
			const native = geolocation(2);
			vi.stubGlobal('navigator', { geolocation: geolocation(1) });
			vi.stubGlobal('window', current);
			let captured = false;
			const snapshot = awaitDevice().then(() => {
				captured = true;
				return resolveDevice();
			});
			yield* Effect.promise(() => Promise.resolve());
			expect(captured).toBe(false);
			Object.defineProperty(current, 'boltDevice', {
				value: { geolocation: { source: 'native', api: native } }
			});
			ready.resolve();
			expect((yield* Effect.promise(() => snapshot)).geolocation?.api).toBe(native);
			const failed = Promise.withResolvers<void>();
			const failure = new Error('native installation refused');
			vi.stubGlobal('window', { boltDeviceReady: failed.promise });
			const rejected = expect(awaitDevice()).rejects.toBe(failure);
			failed.reject(failure);
			yield* Effect.promise(() => rejected);
		})
);

it.effect(
	'awaits no inherited, accessor, parent-frame or thenable readiness and stays immediate without a host',
	() =>
		Effect.gen(function* () {
			const pending = Promise.withResolvers<void>();
			const get = vi.fn(() => pending.promise),
				then = vi.fn();
			class InheritedReady {
				get boltDeviceReady() {
					return pending.promise;
				}
			}
			const accessor = {};
			Object.defineProperty(accessor, 'boltDeviceReady', { get });
			for (const current of [
				new InheritedReady(),
				accessor,
				{ parent: { boltDeviceReady: pending.promise } },
				{ boltDeviceReady: { then } },
				{}
			]) {
				vi.stubGlobal('window', current);
				yield* Effect.promise(awaitDevice);
			}
			vi.stubGlobal('window', undefined);
			yield* Effect.promise(awaitDevice);
			expect(get).not.toHaveBeenCalled();
			expect(then).not.toHaveBeenCalled();
		})
);

it('reads an app shell bound to one workspace as pinned, and nothing else as pinned', () => {
	vi.stubGlobal('navigator', {});
	const install = (value: unknown) => {
		const target = {};
		Object.defineProperty(target, 'boltDevice', { value });
		vi.stubGlobal('window', target);
	};
	install({ platform: 'ios', pinned: true });
	expect(resolveDevice().pinned).toBe(true);
	// a malformed flag is a malformed device: no capability is borrowed from it
	install({ platform: 'ios', pinned: 'yes' });
	expect(resolveDevice()).toEqual({});
	install({ platform: 'web' });
	expect(resolveDevice().pinned).toBeUndefined();
});
