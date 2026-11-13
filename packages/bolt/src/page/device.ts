import { Exit, Schema } from 'effect';
import { PushBody } from '../protocol/schema.ts';

/** A device permission as a host reports it; `prompt` means asking can still grant it. */
export type Access = 'granted' | 'prompt' | 'denied';
/** A native host's permission: its state, asking for it, and the phone's settings when it was refused. */
export type NativePermission = {
	status(): Promise<Access>;
	request(): Promise<Access>;
	open_settings(): Promise<void>;
};

/** A notice the client raises on the device; `id` is the inbox notice's, so raising it again replaces it. */
export type DeviceNotice = {
	readonly id: string;
	readonly title: string;
	readonly body: string | null;
	/** The workspace path it opens (`/inbox?record=jobs/1`). */
	readonly path: string;
};
/** Raising notices on the device, and the path each tapped one opens. */
export type DeviceNotifications = {
	show(notice: DeviceNotice): Promise<void>;
	/** Listens for taps on raised notices; answers the unsubscribe. */
	on_open(listener: (path: string) => void): () => void;
};
/** A device's push endpoint as `POST /__bolt/push` stores it: a browser's web push, or an iOS app's APNs token. */
export type PushRegistration = Exclude<PushBody, { readonly remove: true }>;

/**
 * The device a shell (the native app shell, a desktop shell) installs as `window.bolt_device` (with
 * `window.bolt_device_ready` when installation is asynchronous) before the workspace bundle runs; the same bundle runs
 * on every platform. `mount_shell`'s `device` overrides it. Bolt reads it from an own data property, validates its
 * members and every native result, callback value and unsubscribe handle, and ignores a malformed installation. Every
 * member is optional and feature-detected; without one, Bolt uses the browser's own. Pages read it as `ctx.device`.
 * Availability grants no server authority, and nothing here survives the OS ending the app.
 */
export type DeviceApi = {
	platform?: 'ios' | 'android' | 'web' | 'desktop';
	/**
	 * A shell bound to one workspace (an app): the shell hides its workspace switcher and platform link. An unpinned app
	 * shell leaves it absent and switches workspaces in place; any value but `true` is malformed.
	 */
	pinned?: true;
	/**
	 * Native notifications: their permission, raising one, and the path a tapped one opens. For a signed-in staff member
	 * the shell raises each new unread inbox notice with `show` while the page is hidden (a visible page shows a toast)
	 * and follows a tapped one's path. Without it, the browser's Notification API.
	 */
	notifications?: NativePermission & DeviceNotifications;
	/** Native camera permission, where the host's web view needs one; without it, `getUserMedia`. */
	camera?: NativePermission;
	/**
	 * Native geolocation takes precedence over `navigator.geolocation`; a native denial never switches providers.
	 * `background` reports and opens the OS setting; it cannot grant permission, and a foreground fix does not prove it.
	 */
	geolocation?: {
		source: 'native' | 'browser';
		api: Geolocation;
		/** Native authorization, independently of whether a foreground fix is available. */
		background?: {
			status(): Promise<{ enabled: boolean; always: boolean }>;
			open_settings(): Promise<void>;
		};
	};
	/**
	 * This device's push endpoint (it asks the platform for it, and for permission where the platform needs to), stored
	 * for the member at sign-in and forgotten at sign-out; every device receives, with no setting. Without it, web push
	 * (a service worker and the host's VAPID keys), asked on the member's first click since browsers prompt only on a
	 * gesture; a browser that blocks notifications stores none.
	 */
	push?: { register(): Promise<PushRegistration> };
	/**
	 * A native service holding the absolute `GET /__bolt/notices` URL open with the web view's session cookie while the
	 * app is in the background; stopped at sign-out. The stream sends each notice created after it opened as
	 * `{ id, title, body, path }` (event id: its instant), replays unread ones after `Last-Event-ID` once, pings every 25 s
	 * and ends on a release change; reconnect with `Last-Event-ID`.
	 */
	notices?: { start(options: { url: string }): Promise<void>; stop(): Promise<void> };
	/** Opens a URL outside the workspace in the system browser; the shell routes every link off the workspace origin here. */
	navigation?: { open_external(url: string): Promise<void> };
};

/** Native functions remain unknown until their individual argument, result and callback contracts validate. */
type NativeMethod = (...args: readonly unknown[]) => unknown;
const Callable = Schema.declare(
	(value: unknown): value is NativeMethod => typeof value === 'function',
	{ identifier: 'NativeDeviceMethod' }
);
const callable = Schema.decodeUnknownSync(Callable);
const access = Schema.decodeUnknownSync(Schema.Literals(['granted', 'prompt', 'denied']));
const nothing = Schema.decodeUnknownSync(Schema.Undefined);
const text = Schema.decodeUnknownSync(Schema.String);
const notice = Schema.decodeUnknownSync(
	Schema.Struct({
		id: Schema.String,
		title: Schema.String,
		body: Schema.NullOr(Schema.String),
		path: Schema.String
	})
);
const background_status = Schema.decodeUnknownSync(
	Schema.Struct({ enabled: Schema.Boolean, always: Schema.Boolean })
);
const registration = Schema.decodeUnknownSync(PushBody);
const start_options = Schema.decodeUnknownSync(Schema.Struct({ url: Schema.String }));
const position_options = Schema.decodeUnknownSync(
	Schema.Struct({
		enableHighAccuracy: Schema.optionalKey(Schema.Boolean),
		maximumAge: Schema.optionalKey(Schema.Number),
		timeout: Schema.optionalKey(Schema.Number)
	})
);
const watch_id = Schema.decodeUnknownSync(Schema.Int);
const position = Schema.decodeUnknownSync(
	Schema.Struct({
		coords: Schema.Struct({
			accuracy: Schema.Number,
			altitude: Schema.NullOr(Schema.Number),
			altitudeAccuracy: Schema.NullOr(Schema.Number),
			heading: Schema.NullOr(Schema.Number),
			latitude: Schema.Number,
			longitude: Schema.Number,
			speed: Schema.NullOr(Schema.Number)
		}),
		timestamp: Schema.Number
	})
);
const position_error = Schema.decodeUnknownSync(
	Schema.Struct({
		code: Schema.Number,
		message: Schema.String,
		PERMISSION_DENIED: Schema.Literal(1),
		POSITION_UNAVAILABLE: Schema.Literal(2),
		TIMEOUT: Schema.Literal(3)
	})
);

/** Keep the native receiver: DOM and shell methods can depend on their original object. */
const method = (owner: object, name: string): NativeMethod => {
	const member: unknown = Reflect.get(owner, name);
	const invoke = callable(member);
	return (...args): unknown => Reflect.apply(invoke, owner, args);
};
const promised = async <A>(invoke: () => unknown, decode: (value: unknown) => A): Promise<A> => {
	const result = invoke();
	if (!(result instanceof Promise)) throw new TypeError('A native device method must return a Promise.');
	const value: unknown = await result;
	return decode(value);
};
const permission = (owner: object): NativePermission => {
	const status = method(owner, 'status');
	const request = method(owner, 'request');
	const open_settings = method(owner, 'open_settings');
	return {
		status: () => promised(() => status(), access),
		request: () => promised(() => request(), access),
		open_settings: () => promised(() => open_settings(), nothing)
	};
};
const notifications = (owner: object): NativePermission & DeviceNotifications => {
	const permissions = permission(owner);
	const show = method(owner, 'show');
	const on_open = method(owner, 'on_open');
	return {
		...permissions,
		show: (value) => promised(() => show(notice(value)), nothing),
		on_open: (listener) => {
			if (typeof listener !== 'function')
				throw new TypeError('A notification listener must be a function.');
			const off = callable(on_open((path: unknown) => listener(text(path))));
			return () => {
				nothing(off());
			};
		}
	};
};
const geolocation = (owner: object): Geolocation => {
	const current = method(owner, 'getCurrentPosition');
	const watch = method(owner, 'watchPosition');
	const clear = method(owner, 'clearWatch');
	const callbacks = (success: PositionCallback, error: PositionErrorCallback | null | undefined) => {
		if (typeof success !== 'function') throw new TypeError('A location listener must be a function.');
		if (error !== undefined && error !== null && typeof error !== 'function')
			throw new TypeError('A location error listener must be a function.');
		return {
			success: (value: unknown) => {
				const point = position(value);
				const coords: GeolocationCoordinates = {
					...point.coords,
					toJSON: () => ({ ...point.coords })
				};
				success({
					coords,
					timestamp: point.timestamp,
					toJSON: () => ({ coords: { ...point.coords }, timestamp: point.timestamp })
				});
			},
			error:
				error === undefined || error === null
					? error
					: (value: unknown) => error(position_error(value))
		};
	};
	return {
		getCurrentPosition: (success, error, options) => {
			const listener = callbacks(success, error);
			nothing(
				current(
					listener.success,
					listener.error,
					options === undefined ? undefined : position_options(options)
				)
			);
		},
		watchPosition: (success, error, options) => {
			const listener = callbacks(success, error);
			return watch_id(
				watch(
					listener.success,
					listener.error,
					options === undefined ? undefined : position_options(options)
				)
			);
		},
		clearWatch: (id) => {
			nothing(clear(watch_id(id)));
		}
	};
};
const decodeDevice = Schema.decodeUnknownExit(
	Schema.Struct({
		platform: Schema.optionalKey(Schema.Literals(['ios', 'android', 'web', 'desktop'])),
		pinned: Schema.optionalKey(Schema.Literal(true)),
		notifications: Schema.optionalKey(Schema.ObjectKeyword),
		camera: Schema.optionalKey(Schema.ObjectKeyword),
		geolocation: Schema.optionalKey(
			Schema.Struct({
				source: Schema.Literals(['native', 'browser']),
				api: Schema.ObjectKeyword,
				background: Schema.optionalKey(Schema.ObjectKeyword)
			})
		),
		push: Schema.optionalKey(Schema.ObjectKeyword),
		notices: Schema.optionalKey(Schema.ObjectKeyword),
		navigation: Schema.optionalKey(Schema.ObjectKeyword)
	}),
	{ onExcessProperty: 'error' }
);
const installedDevice = (): DeviceApi | undefined => {
	if (typeof window === 'undefined') return undefined;
	const descriptor: TypedPropertyDescriptor<unknown> | undefined = Object.getOwnPropertyDescriptor(
		window,
		'bolt_device'
	);
	const value: unknown = descriptor?.value;
	const decoded = decodeDevice(value);
	if (Exit.isFailure(decoded)) return undefined;
	const native = decoded.value;
	try {
		const device: DeviceApi = {};
		if (native.platform !== undefined) device.platform = native.platform;
		if (native.pinned !== undefined) device.pinned = native.pinned;
		if (native.camera !== undefined) device.camera = permission(native.camera);
		if (native.notifications !== undefined) device.notifications = notifications(native.notifications);
		if (native.geolocation !== undefined) {
			const location = native.geolocation;
			device.geolocation = { source: location.source, api: geolocation(location.api) };
			if (location.background !== undefined) {
				const status = method(location.background, 'status');
				const open_settings = method(location.background, 'open_settings');
				device.geolocation.background = {
					status: () => promised(() => status(), background_status),
					open_settings: () => promised(() => open_settings(), nothing)
				};
			}
		}
		if (native.push !== undefined) {
			const register = method(native.push, 'register');
			device.push = {
				register: () =>
					promised(() => register(), (value) => {
						const body = registration(value);
						if ('remove' in body)
							throw new TypeError('A native push registration cannot remove an endpoint.');
						return body;
					})
			};
		}
		if (native.notices !== undefined) {
			const start = method(native.notices, 'start');
			const stop = method(native.notices, 'stop');
			device.notices = {
				start: (options) => promised(() => start(start_options(options)), nothing),
				stop: () => promised(() => stop(), nothing)
			};
		}
		if (native.navigation !== undefined) {
			const open_external = method(native.navigation, 'open_external');
			device.navigation = {
				open_external: (url) => promised(() => open_external(text(url)), nothing)
			};
		}
		return device;
	} catch {
		return undefined;
	}
};

/** Await only this document's own native startup promise, without invoking getters or trusting thenables. */
export function await_device(): Promise<void> {
	if (typeof window === 'undefined') return Promise.resolve();
	const descriptor: TypedPropertyDescriptor<unknown> | undefined = Object.getOwnPropertyDescriptor(
		window,
		'bolt_device_ready'
	);
	const value: unknown = descriptor?.value;
	return value instanceof Promise ? value.then(() => undefined) : Promise.resolve();
}

/** Explicit device win; otherwise read this document's own native descriptor before browser fallback. */
export function resolve_device(host?: DeviceApi): DeviceApi {
	const apis = host === undefined ? (installedDevice() ?? {}) : host;
	if (apis.geolocation !== undefined) return apis;
	return typeof navigator !== 'undefined' && navigator.geolocation !== undefined
		? { ...apis, geolocation: { source: 'browser', api: navigator.geolocation } }
		: apis;
}
