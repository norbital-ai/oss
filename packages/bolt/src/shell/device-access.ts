// Native Device take precedence; permission refusal never switches providers.
import { Effect, Schema } from 'effect';
import type { Access, DeviceApi } from '../page/device.ts';
import type { DeviceRequirement } from '../decl/runtime/app.ts';

export type DeviceAccessState = {
	readonly state: Access | 'unsupported';
	readonly settings: boolean;
};
export type DeviceAccess = {
	check(requirement: DeviceRequirement): Effect.Effect<DeviceAccessState>;
	request(requirement: DeviceRequirement): Effect.Effect<void>;
	openSettings(requirement: DeviceRequirement): Effect.Effect<void>;
};
class DeviceAccessFailure extends Schema.TaggedError<DeviceAccessFailure>()('DeviceAccessFailure', {
	operation: Schema.String
}) {}
const attempt = <A>(operation: string, promise: () => Promise<A>, fallback: A) =>
	Effect.tryPromise({
		try: promise,
		catch: () => new DeviceAccessFailure({ operation })
	}).pipe(Effect.catch(() => Effect.succeed(fallback)));
const query = (name: string) =>
	typeof navigator === 'undefined' || navigator.permissions === undefined
		? Effect.succeed<Access | null>(null)
		: attempt<PermissionStatus | null>(
				'permissions.query',
				() => navigator.permissions.query({ name: name as PermissionName }),
				null
			).pipe(Effect.map((status) => status?.state ?? null));
const proven = new Set<'camera' | 'location'>();
const position = (geo: Geolocation) =>
	Effect.callback<boolean>((resume) => {
		geo.getCurrentPosition(
			() => resume(Effect.succeed(true)),
			() => resume(Effect.succeed(false)),
			{ timeout: 15_000 }
		);
	});

export function deviceAccess(device: DeviceApi): DeviceAccess {
	const geo = device.geolocation;
	const notify = typeof Notification !== 'undefined';
	const camera =
		typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia !== undefined;
	const native = (requirement: DeviceRequirement) =>
		requirement === 'notifications'
			? device.notifications
			: requirement === 'camera'
				? device.camera
				: undefined;
	const check = (requirement: DeviceRequirement) =>
		Effect.gen(function* () {
			const permission = native(requirement);
			if (permission !== undefined)
				return {
					state: yield* attempt<Access>('native.status', () => permission.status(), 'prompt'),
					settings: true
				};
			if (requirement === 'location' || requirement === 'location:background') {
				if (geo === undefined) return { state: 'unsupported' as const, settings: false };
				const backgroundPermission = geo.background;
				if (geo.source === 'native' && backgroundPermission !== undefined) {
					const background = yield* attempt(
						'background.status',
						() => backgroundPermission.status(),
						{ enabled: false, always: false }
					);
					if (requirement === 'location:background' && background.enabled && !background.always)
						return { state: 'denied' as const, settings: true };
					if (background.enabled && (background.always || requirement === 'location'))
						return { state: 'granted' as const, settings: true };
				}
				return {
					state: proven.has('location')
						? ('granted' as const)
						: ((yield* query('geolocation')) ?? 'prompt'),
					settings: geo.source === 'native'
				};
			}
			if (requirement === 'notifications')
				return notify
					? {
							state:
								Notification.permission === 'default'
									? ('prompt' as const)
									: Notification.permission,
							settings: false
						}
					: { state: 'unsupported' as const, settings: false };
			if (!camera) return { state: 'unsupported' as const, settings: false };
			return {
				state: proven.has('camera') ? ('granted' as const) : ((yield* query('camera')) ?? 'prompt'),
				settings: false
			};
		});
	const request = (requirement: DeviceRequirement) =>
		Effect.gen(function* () {
			const permission = native(requirement);
			if (permission !== undefined) {
				yield* attempt<Access>('native.request', () => permission.request(), 'prompt');
				return;
			}
			if (requirement === 'location' || requirement === 'location:background') {
				if (geo !== undefined && (yield* position(geo.api))) proven.add('location');
				return;
			}
			if (requirement === 'notifications') {
				if (notify)
					yield* attempt(
						'notifications.request',
						() => Notification.requestPermission(),
						'default'
					);
				return;
			}
			if (!camera) return;
			const stream = yield* attempt<MediaStream | null>(
				'camera.request',
				() => navigator.mediaDevices.getUserMedia({ video: true }),
				null
			);
			if (stream !== null) {
				proven.add('camera');
				for (const track of stream.getTracks()) track.stop();
			}
		});
	const openSettings = (requirement: DeviceRequirement) => {
		const permission = native(requirement);
		if (permission !== undefined)
			return attempt('native.openSettings', () => permission.openSettings(), undefined);
		const background = geo?.background;
		return (requirement === 'location' || requirement === 'location:background') &&
			background !== undefined
			? attempt('background.openSettings', () => background.openSettings(), undefined)
			: Effect.void;
	};
	const table: Record<
		DeviceRequirement,
		{
			check: Effect.Effect<DeviceAccessState>;
			request: Effect.Effect<void>;
			openSettings: Effect.Effect<void>;
		}
	> = {
		camera: {
			check: check('camera'),
			request: request('camera'),
			openSettings: openSettings('camera')
		},
		location: {
			check: check('location'),
			request: request('location'),
			openSettings: openSettings('location')
		},
		'location:background': {
			check: check('location:background'),
			request: request('location:background'),
			openSettings: openSettings('location:background')
		},
		notifications: {
			check: check('notifications'),
			request: request('notifications'),
			openSettings: openSettings('notifications')
		}
	};
	return {
		check: (requirement) => table[requirement].check,
		request: (requirement) => table[requirement].request,
		openSettings: (requirement) => table[requirement].openSettings
	};
}
