import { Exit, Schema } from 'effect';
import type { PushBody } from '../protocol/schema.ts';

/** A device permission as a host reports it; `prompt` means asking can still grant it. */
export type Access = 'granted' | 'prompt' | 'denied';
/** A native host's permission: its state, asking for it, and the phone's settings when it was refused. */
export type NativePermission = {
	status(): Promise<Access>;
	request(): Promise<Access>;
	openSettings(): Promise<void>;
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
	onOpen(listener: (path: string) => void): () => void;
};
/** A device's push endpoint as `POST /__bolt/push` stores it: a browser's web push, or an iOS app's APNs token. */
export type PushRegistration = Exclude<PushBody, { readonly remove: true }>;

/**
 * the device a shell (the native app shell, a desktop shell) installs as `window.boltDevice`
 * before the workspace bundle runs; every member is optional and feature-detected. Without one, Bolt uses the
 * browser's own device. Availability grants no server authority.
 */
export type DeviceApi = {
	platform?: 'ios' | 'android' | 'web' | 'desktop';
	/** A shell bound to one workspace (an app): the page offers no way to another workspace. */
	pinned?: true;
	/** Native notifications: their permission, raising one, and the path a tapped one opens. */
	notifications?: NativePermission & DeviceNotifications;
	/** Native camera permission, where the host's web view needs one. */
	camera?: NativePermission;
	geolocation?: {
		source: 'native' | 'browser';
		api: Geolocation;
		/** Native authorization, independently of whether a foreground fix is available. */
		background?: {
			status(): Promise<{ enabled: boolean; always: boolean }>;
			openSettings(): Promise<void>;
		};
	};
	/** This device's push endpoint (it asks the platform for it, and for permission where the platform needs to). */
	push?: { register(): Promise<PushRegistration> };
	/** A native service holding `GET /__bolt/notices` open while the app is in the background. */
	notices?: { start(options: { url: string }): Promise<void>; stop(): Promise<void> };
	/** Opens a URL outside the workspace in the system browser. */
	navigation?: { openExternal(url: string): Promise<void> };
};

/** Native ports are opaque function ABIs: decoding checks their members are functions and calls none of them. */
const functions = <T extends object>(names: readonly string[]) =>
	Schema.declare<T>(
		(value): value is T =>
			typeof value === 'object' &&
			value !== null &&
			names.every((name) => typeof Reflect.get(value, name) === 'function')
	);
type DeviceMember<K extends keyof DeviceApi> = NonNullable<DeviceApi[K]>;
const Permission = functions<NativePermission>(['status', 'request', 'openSettings']);
const decodeDevice = Schema.decodeUnknownExit(
	Schema.Struct({
		platform: Schema.optionalKey(Schema.Literals(['ios', 'android', 'web', 'desktop'])),
		pinned: Schema.optionalKey(Schema.Literal(true)),
		notifications: Schema.optionalKey(
			functions<DeviceMember<'notifications'>>([
				'status',
				'request',
				'openSettings',
				'show',
				'onOpen'
			])
		),
		camera: Schema.optionalKey(Permission),
		geolocation: Schema.optionalKey(
			Schema.Struct({
				source: Schema.Literals(['native', 'browser']),
				api: functions<Geolocation>(['getCurrentPosition', 'watchPosition', 'clearWatch']),
				background: Schema.optionalKey(
					functions<NonNullable<DeviceMember<'geolocation'>['background']>>([
						'status',
						'openSettings'
					])
				)
			})
		),
		push: Schema.optionalKey(functions<DeviceMember<'push'>>(['register'])),
		notices: Schema.optionalKey(functions<DeviceMember<'notices'>>(['start', 'stop'])),
		navigation: Schema.optionalKey(functions<DeviceMember<'navigation'>>(['openExternal']))
	}),
	{ onExcessProperty: 'error' }
);
const installedDevice = (): DeviceApi | undefined => {
	if (typeof window === 'undefined') return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(window, 'boltDevice');
	const value: unknown = descriptor?.value;
	const decoded = decodeDevice(value);
	return Exit.isSuccess(decoded) ? decoded.value : undefined;
};

/** Await only this document's own native startup promise, without invoking getters or trusting thenables. */
export function awaitDevice(): Promise<void> {
	if (typeof window === 'undefined') return Promise.resolve();
	const descriptor = Object.getOwnPropertyDescriptor(window, 'boltDeviceReady');
	const value: unknown = descriptor?.value;
	return value instanceof Promise ? value.then(() => undefined) : Promise.resolve();
}

/** Explicit device win; otherwise read this document's own native descriptor before browser fallback. */
export function resolveDevice(host?: DeviceApi): DeviceApi {
	const apis = host === undefined ? (installedDevice() ?? {}) : host;
	if (apis.geolocation !== undefined) return apis;
	return typeof navigator !== 'undefined' && navigator.geolocation !== undefined
		? { ...apis, geolocation: { source: 'browser', api: navigator.geolocation } }
		: apis;
}
