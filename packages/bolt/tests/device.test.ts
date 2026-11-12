import { afterEach, expect, it, vi } from '@effect/vitest';
import { Effect } from 'effect';
import {
	await_device,
	resolve_device,
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
	expect(resolve_device().geolocation).toEqual({ source: 'browser', api: browser });
	expect(resolve_device({ geolocation: { source: 'native', api: native } }).geolocation).toEqual({
		source: 'native',
		api: native
	});
	expect(resolve_device({ geolocation: { source: 'browser', api: browser } }).geolocation?.api).toBe(
		browser
	);
	vi.stubGlobal('window', {});
	vi.stubGlobal('navigator', {});
	expect(resolve_device()).toEqual({});
	vi.stubGlobal('navigator', undefined);
	vi.stubGlobal('window', undefined);
	expect(resolve_device()).toEqual({});
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
				open_settings: vi.fn(async () => undefined)
			};
			const camera: NativePermission = {
				status: vi.fn(async () => 'denied' as const),
				request: vi.fn(async () => 'denied' as const),
				open_settings: vi.fn(async () => undefined)
			};
			const notifications = {
				...camera,
				show: vi.fn(async () => undefined),
				on_open: vi.fn(() => () => undefined)
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
						keys: { topic: 't', environment: 'production' as const, team_id: 'T' }
					}))
				},
				notices: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
				navigation: { open_external: vi.fn(async () => undefined) }
			};
			vi.stubGlobal('navigator', { geolocation: geolocation(1) });
			vi.stubGlobal('window', { bolt_device: Object.freeze(native) });
			const apis = resolve_device();
			expect(apis.geolocation?.source).toBe('native');
			expect(apis.platform).toBe('ios');
			expect(Object.keys(apis).sort()).toEqual([
				'camera', 'geolocation', 'navigation', 'notices', 'notifications', 'platform', 'push'
			]);
			expect(background.status).not.toHaveBeenCalled();
			expect(notifications.status).not.toHaveBeenCalled();
			expect(native.push?.register).not.toHaveBeenCalled();
			const wall = deviceAccess(apis);
			expect(yield* wall.check('location:background')).toEqual({ state: 'denied', settings: true });
			expect(yield* wall.check('notifications')).toEqual({ state: 'denied', settings: true });
			yield* wall.open_settings('notifications');
			expect(notifications.open_settings).toHaveBeenCalledOnce();
		})
);

it('reads late injection and teardown on each call while an explicit override remains authoritative', () => {
	const browser = geolocation(1),
		native = geolocation(2),
		explicit = geolocation(3);
	const current = {};
	vi.stubGlobal('navigator', { geolocation: browser });
	vi.stubGlobal('window', current);
	expect(resolve_device().geolocation?.api).toBe(browser);
	Object.defineProperty(current, 'bolt_device', {
		value: { geolocation: { source: 'native', api: native } },
		configurable: true
	});
	expect(resolve_device().geolocation?.api.watchPosition(() => undefined)).toBe(2);
	expect(resolve_device({}).geolocation?.api).toBe(browser);
	const supplied: DeviceApi = { geolocation: { source: 'native', api: explicit } };
	expect(resolve_device(supplied)).toBe(supplied);
	Reflect.deleteProperty(current, 'bolt_device');
	expect(resolve_device().geolocation?.api).toBe(browser);
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
		vi.stubGlobal('window', { bolt_device: value });
		expect(resolve_device()).toEqual({ geolocation: { source: 'browser', api: browser } });
	}
	const injected: DeviceApi = { geolocation: { source: 'native', api: native } };
	class InheritedFacilities {
		get bolt_device() {
			return injected;
		}
	}
	vi.stubGlobal('window', new InheritedFacilities());
	expect(resolve_device().geolocation?.api).toBe(browser);
	const get = vi.fn(() => injected);
	const current = {};
	Object.defineProperty(current, 'bolt_device', { get });
	vi.stubGlobal('window', current);
	expect(resolve_device().geolocation?.api).toBe(browser);
	expect(get).not.toHaveBeenCalled();
	vi.stubGlobal('window', { parent: { bolt_device: injected } });
	expect(resolve_device().geolocation?.api).toBe(browser);
});

it.effect(
	'waits for asynchronous host installation before taking the native Device snapshot and propagates startup failure',
	() =>
		Effect.gen(function* () {
			const ready = Promise.withResolvers<void>();
			const current = { bolt_device_ready: ready.promise };
			const native = geolocation(2);
			vi.stubGlobal('navigator', { geolocation: geolocation(1) });
			vi.stubGlobal('window', current);
			let captured = false;
			const snapshot = await_device().then(() => {
				captured = true;
				return resolve_device();
			});
			yield* Effect.promise(() => Promise.resolve());
			expect(captured).toBe(false);
			Object.defineProperty(current, 'bolt_device', {
				value: { geolocation: { source: 'native', api: native } }
			});
			ready.resolve();
			expect(
				(yield* Effect.promise(() => snapshot)).geolocation?.api.watchPosition(() => undefined)
			).toBe(2);
			const failed = Promise.withResolvers<void>();
			const failure = new Error('native installation refused');
			vi.stubGlobal('window', { bolt_device_ready: failed.promise });
			const rejected = expect(await_device()).rejects.toBe(failure);
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
				get bolt_device_ready() {
					return pending.promise;
				}
			}
			const accessor = {};
			Object.defineProperty(accessor, 'bolt_device_ready', { get });
			for (const current of [
				new InheritedReady(),
				accessor,
				{ parent: { bolt_device_ready: pending.promise } },
				{ bolt_device_ready: { then } },
				{}
			]) {
				vi.stubGlobal('window', current);
				yield* Effect.promise(await_device);
			}
			vi.stubGlobal('window', undefined);
			yield* Effect.promise(await_device);
			expect(get).not.toHaveBeenCalled();
			expect(then).not.toHaveBeenCalled();
		})
);

it('reads an app shell bound to one workspace as pinned, and nothing else as pinned', () => {
	vi.stubGlobal('navigator', {});
	const install = (value: unknown) => {
		const target = {};
		Object.defineProperty(target, 'bolt_device', { value });
		vi.stubGlobal('window', target);
	};
	install({ platform: 'ios', pinned: true });
	expect(resolve_device().pinned).toBe(true);
	// a malformed flag is a malformed device: no capability is borrowed from it
	install({ platform: 'ios', pinned: 'yes' });
	expect(resolve_device()).toEqual({});
	install({ platform: 'web' });
	expect(resolve_device().pinned).toBeUndefined();
});

it('validates native Promise results without losing permission states, receivers or failures', async () => {
	class PermissionPort {
		response: unknown = Promise.resolve('prompt');
		opened = 0;
		status() { return this.response; }
		request() { return this.response; }
		async open_settings() { this.opened++; }
	}
	const port = new PermissionPort();
	let authorization: unknown = { enabled: true, always: false };
	let endpoint: unknown = {
		kind: 'apns', endpoint: 'ab',
		keys: { topic: 'ai.norbital.app', environment: 'production', team_id: 'TEAM' }
	};
	let completion: unknown = undefined;
	const started: string[] = [], opened: string[] = [];
	vi.stubGlobal('navigator', {});
	vi.stubGlobal('window', { bolt_device: {
		camera: port,
		geolocation: {
			source: 'native', api: geolocation(2),
			background: {
				status: () => Promise.resolve(authorization),
				open_settings: async () => undefined
			}
		},
		push: { register: () => Promise.resolve(endpoint) },
		notices: {
			start: (options: { url: string }) => {
				started.push(options.url);
				return Promise.resolve(completion);
			},
			stop: () => Promise.resolve(completion)
		},
		navigation: { open_external: (url: string) => {
			opened.push(url);
			return Promise.resolve(completion);
		} }
	} });
	const device = resolve_device();
	const camera = device.camera, background = device.geolocation?.background,
		push = device.push, notices = device.notices, navigation = device.navigation;
	if (camera === undefined || background === undefined || push === undefined ||
		notices === undefined || navigation === undefined) throw new Error('Missing native device capability');
	for (const state of ['granted', 'prompt', 'denied']) {
		port.response = Promise.resolve(state);
		expect(await camera.status()).toBe(state);
		expect(await camera.request()).toBe(state);
	}
	await camera.open_settings();
	expect(port.opened).toBe(1);
	expect(await background.status()).toEqual({ enabled: true, always: false });
	expect(await push.register()).toEqual(endpoint);
	await notices.start({ url: 'https://workspace.example/__bolt/notices' });
	await notices.stop();
	await navigation.open_external('https://outside.example/');
	expect(started).toEqual(['https://workspace.example/__bolt/notices']);
	expect(opened).toEqual(['https://outside.example/']);
	port.response = Promise.resolve('allowed');
	await expect(camera.status()).rejects.toThrow();
	await expect(camera.request()).rejects.toThrow();
	port.response = 'granted';
	await expect(camera.status()).rejects.toThrow(TypeError);
	const failure = new Error('native permission unavailable');
	port.response = Promise.reject(failure);
	await expect(camera.status()).rejects.toBe(failure);
	authorization = { enabled: true, always: 'yes' };
	await expect(background.status()).rejects.toThrow();
	endpoint = { endpoint: 'ab', remove: true };
	await expect(push.register()).rejects.toThrow(TypeError);
	endpoint = { kind: 'apns', endpoint: 'ab', keys: { topic: 2 } };
	await expect(push.register()).rejects.toThrow();
	completion = 'unexpected result';
	await expect(notices.stop()).rejects.toThrow();
	await expect(navigation.open_external('https://outside.example/')).rejects.toThrow();
});

it('validates notification tap payloads and unsubscribe results while retaining subscription cleanup', async () => {
	const listeners = new Set<(value: unknown) => void>();
	const shown: unknown[] = [];
	let malformed_unsubscribe = false;
	let cleanup_result: unknown = undefined;
	const native = {
		listeners,
		status: async () => 'granted',
		request: async () => 'granted',
		open_settings: async () => undefined,
		show: async (value: unknown) => { shown.push(value); },
		on_open(listener: (value: unknown) => void) {
			this.listeners.add(listener);
			listener('/inbox?record=jobs/1');
			return malformed_unsubscribe ? false : () => {
				this.listeners.delete(listener);
				return cleanup_result;
			};
		}
	};
	vi.stubGlobal('navigator', {});
	vi.stubGlobal('window', { bolt_device: { notifications: native } });
	const notifications = resolve_device().notifications;
	if (notifications === undefined) throw new Error('Missing native notifications');
	const tapped = vi.fn();
	const off = notifications.on_open(tapped);
	expect(tapped).toHaveBeenCalledWith('/inbox?record=jobs/1');
	for (const listener of listeners) {
		expect(() => listener(42)).toThrow();
		listener('/inbox');
	}
	expect(tapped).toHaveBeenCalledTimes(2);
	const notice = { id: 'a', title: 'Ready', body: null, path: '/inbox' };
	await notifications.show(notice);
	expect(shown).toEqual([notice]);
	off();
	expect(listeners.size).toBe(0);
	const bad_cleanup = notifications.on_open(tapped);
	cleanup_result = false;
	expect(bad_cleanup).toThrow();
	expect(listeners.size).toBe(0);
	malformed_unsubscribe = true;
	expect(() => notifications.on_open(tapped)).toThrow();
});

it('decodes full native location callbacks, options and watch handles while retaining cancellation', () => {
	const point = {
		coords: {
			latitude: 1.3, longitude: 103.8, accuracy: 4, altitude: null,
			altitudeAccuracy: null, heading: null, speed: 0
		},
		timestamp: 1234
	};
	const problem = {
		code: 3, message: 'Timed out', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3
	};
	class NativePosition {
		get coords() { return point.coords; }
		get timestamp() { return point.timestamp; }
	}
	const watched = new Map<number, (value: unknown) => void>();
	const options_seen: Array<PositionOptions | undefined> = [];
	let current_point: unknown = new NativePosition(), current_error: unknown = undefined;
	let current_result: unknown = undefined, handle: unknown = 7;
	const native = {
		watched,
		getCurrentPosition(
			success: (value: unknown) => void,
			error: ((value: unknown) => void) | null | undefined,
			options?: PositionOptions
		) {
			options_seen.push(options);
			if (current_error === undefined) success(current_point);
			else error?.(current_error);
			return current_result;
		},
		watchPosition(success: (value: unknown) => void, _error: unknown, options?: PositionOptions) {
			options_seen.push(options);
			this.watched.set(7, success);
			return handle;
		},
		clearWatch(id: number) { this.watched.delete(id); }
	};
	vi.stubGlobal('navigator', {});
	vi.stubGlobal('window', { bolt_device: { geolocation: { source: 'native', api: native } } });
	const api = resolve_device().geolocation?.api;
	if (api === undefined) throw new Error('Missing native location');
	const received: unknown[] = [], errors: GeolocationPositionError[] = [];
	const receive = (value: GeolocationPosition) => {
		received.push(value.toJSON());
		expect(value.coords.toJSON()).toEqual(point.coords);
	};
	const options = { enableHighAccuracy: true, maximumAge: 0 };
	api.getCurrentPosition(receive, (error) => errors.push(error), options);
	expect(received).toEqual([point]);
	const id = api.watchPosition(receive, null, options);
	expect(id).toBe(7);
	expect(options_seen).toEqual([options, options]);
	for (const listener of watched.values()) listener(point);
	expect(received).toHaveLength(2);
	api.clearWatch(id);
	expect(watched.size).toBe(0);
	current_error = problem;
	api.getCurrentPosition(receive, (error) => errors.push(error));
	expect(errors).toEqual([problem]);
	current_error = { ...problem, message: 4 };
	expect(() => api.getCurrentPosition(receive, (error) => errors.push(error))).toThrow();
	expect(errors).toHaveLength(1);
	current_error = undefined;
	current_point = { ...point, coords: { ...point.coords, latitude: 'north' } };
	expect(() => api.getCurrentPosition(receive)).toThrow();
	expect(received).toHaveLength(2);
	current_point = point;
	current_result = true;
	expect(() => api.getCurrentPosition(receive)).toThrow();
	handle = 'seven';
	expect(() => api.watchPosition(receive)).toThrow();
});
