import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type {
	BackgroundGeolocationPlugin,
	Location
} from '@capacitor-community/background-geolocation';
import { Clock, Deferred, Effect, Fiber, FiberSet, Option, Schema } from 'effect';
import { NorbitalShell } from './plugin.ts';

class LocationFailure extends Schema.TaggedError<LocationFailure>()(
	'NorbitalShell.LocationFailure',
	{
		denied: Schema.Boolean,
		message: Schema.String
	}
) {}
const NativeFailure = Schema.Struct({
	code: Schema.optionalKey(Schema.String),
	message: Schema.optionalKey(Schema.String)
});
const native = <A>(work: () => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: (cause) => {
			const decoded = Schema.decodeUnknownOption(NativeFailure)(cause);
			return new LocationFailure({
				denied: Option.isSome(decoded) && decoded.value.code === 'NOT_AUTHORIZED',
				message: Option.isSome(decoded)
					? (decoded.value.message ?? 'Location permission was refused.')
					: 'Location permission was refused.'
			});
		}
	});
const Status = Schema.Struct({ enabled: Schema.Boolean, always: Schema.Boolean });
export const backgroundLocation = {
	status: native(() => NorbitalShell.locationStatus()).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Status))
	),
	openSettings: native(() => NorbitalShell.openSettings())
};
const tracker = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');
function positionOf(point: Location, now: number): GeolocationPosition {
	const coords = {
		latitude: point.latitude,
		longitude: point.longitude,
		accuracy: point.accuracy,
		altitude: point.altitude,
		altitudeAccuracy: point.altitudeAccuracy,
		heading: point.bearing,
		speed: point.speed,
		toJSON() {
			return {
				latitude: this.latitude,
				longitude: this.longitude,
				accuracy: this.accuracy,
				altitude: this.altitude,
				altitudeAccuracy: this.altitudeAccuracy,
				heading: this.heading,
				speed: this.speed
			};
		}
	};
	return {
		coords,
		timestamp: point.time ?? now,
		toJSON() {
			return { coords: coords.toJSON(), timestamp: this.timestamp };
		}
	};
}
/**
 * Replaces `navigator.geolocation` with the native tracker. With `background`, `watchPosition` keeps reporting while
 * the phone is locked (Android shows the tracker's foreground notification); `getCurrentPosition` is always foreground.
 */
export const installLocation = (background: boolean) =>
	Effect.gen(function* () {
		const run = yield* FiberSet.makeRuntime();
		const originalGeo = Object.getOwnPropertyDescriptor(navigator, 'geolocation');
		const createdGeo = navigator.geolocation === undefined;
		const geo: Partial<Geolocation> = navigator.geolocation ?? {};
		const original = {
			watch: Object.getOwnPropertyDescriptor(geo, 'watchPosition'),
			current: Object.getOwnPropertyDescriptor(geo, 'getCurrentPosition'),
			clear: Object.getOwnPropertyDescriptor(geo, 'clearWatch')
		};
		if (navigator.geolocation === undefined)
			Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true });
		const watches = new Map<number, Fiber.Fiber<unknown, unknown>>();
		let next = 0;
		const fail = (
			callback: PositionErrorCallback | null | undefined,
			denied: boolean,
			message: string
		) =>
			callback?.({
				code: denied ? 1 : 2,
				message,
				PERMISSION_DENIED: 1,
				POSITION_UNAVAILABLE: 2,
				TIMEOUT: 3
			});
		const stopWatch = (id: number) => {
			const fiber = watches.get(id);
			watches.delete(id);
			return fiber === undefined ? Effect.void : Fiber.interrupt(fiber);
		};
		const clearWatch = (id: number) => {
			run(stopWatch(id));
		};
		const stopWatches = () => {
			const fibers = [...watches.values()];
			watches.clear();
			return Fiber.interruptAll(fibers);
		};
		const watch = (
			success: PositionCallback,
			error: PositionErrorCallback | null | undefined,
			continuous: boolean
		): number => {
			const id = ++next;
			const effect = Effect.gen(function* () {
				if (continuous && Capacitor.getPlatform() === 'android') {
					const permission = yield* native(() => LocalNotifications.requestPermissions());
					if (permission.display !== 'granted')
						return yield* new LocationFailure({
							denied: true,
							message: 'Allow notifications to enable background location sharing.'
						});
				}
				yield* Effect.acquireRelease(
					native(() =>
						tracker.addWatcher(
							{
								...(continuous
									? {
											backgroundTitle: 'Location sharing',
											backgroundMessage:
												'Your workspace is receiving your location while you are signed in.'
										}
									: {}),
								requestPermissions: true,
								stale: false,
								distanceFilter: 0
							},
							(point, problem) => {
								if (!watches.has(id)) return;
								if (problem !== undefined) {
									const denied = problem.code === 'NOT_AUTHORIZED';
									if (denied) clearWatch(id);
									fail(error, denied, problem.message);
								} else if (point !== undefined)
									run(
										Clock.currentTimeMillis.pipe(
											Effect.flatMap((now) => Effect.sync(() => success(positionOf(point, now))))
										)
									);
							}
						)
					),
					(nativeId) =>
						native(() => tracker.removeWatcher({ id: nativeId })).pipe(
							Effect.tapCause(Effect.logWarning),
							Effect.ignore
						)
				);
				yield* Effect.never;
			}).pipe(
				Effect.scoped,
				Effect.catch((problem) =>
					Effect.sync(() => {
						if (!watches.delete(id)) return;
						fail(error, problem.denied, problem.message);
					})
				)
			);
			const fiber = run(effect);
			watches.set(id, fiber);
			return id;
		};
		Object.defineProperty(geo, 'watchPosition', {
			configurable: true,
			value: (success: PositionCallback, error?: PositionErrorCallback | null) =>
				watch(success, error, background)
		});
		Object.defineProperty(geo, 'clearWatch', { configurable: true, value: clearWatch });
		Object.defineProperty(geo, 'getCurrentPosition', {
			configurable: true,
			value: (
				success: PositionCallback,
				error?: PositionErrorCallback | null,
				options?: PositionOptions
			) => {
				const first = Effect.scoped(
					Effect.gen(function* () {
						const answer = yield* Deferred.make<GeolocationPosition, GeolocationPositionError>();
						yield* Effect.acquireRelease(
							Effect.sync(() =>
								watch(
									(position) => run(Deferred.succeed(answer, position)),
									(problem) => run(Deferred.fail(answer, problem)),
									false
								)
							),
							stopWatch
						);
						return yield* Deferred.await(answer);
					})
				);
				const request =
					options?.timeout === undefined || !Number.isFinite(options.timeout)
						? first
						: first.pipe(
								Effect.timeoutOrElse({
									duration: Math.max(0, options.timeout),
									orElse: () =>
										Effect.fail({
											code: 3,
											message: 'Location request timed out.',
											PERMISSION_DENIED: 1,
											POSITION_UNAVAILABLE: 2,
											TIMEOUT: 3
										} satisfies GeolocationPositionError)
								})
							);
				run(
					request.pipe(
						Effect.matchEffect({
							onSuccess: (position) => Effect.sync(() => success(position)),
							onFailure: (problem) => Effect.sync(() => error?.(problem))
						})
					)
				);
			}
		});
		const pagehide = () => {
			run(stopWatches());
		};
		yield* Effect.acquireRelease(
			Effect.sync(() => window.addEventListener('pagehide', pagehide)),
			() => Effect.sync(() => window.removeEventListener('pagehide', pagehide))
		);
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				yield* stopWatches();
				for (const [name, descriptor] of [
					['watchPosition', original.watch],
					['getCurrentPosition', original.current],
					['clearWatch', original.clear]
				] as const)
					if (descriptor === undefined) Reflect.deleteProperty(geo, name);
					else Object.defineProperty(geo, name, descriptor);
				if (createdGeo) {
					if (originalGeo === undefined) Reflect.deleteProperty(navigator, 'geolocation');
					else Object.defineProperty(navigator, 'geolocation', originalGeo);
				}
			})
		);
	});
/**
 * Native HTTP is the Android fetch ABI for workspace writes (`/__bolt/act`): a locked phone suspends the WebView's
 * network stack, so background location writes travel through Capacitor's native client.
 */
export const installLocationTransport = Effect.gen(function* () {
	if (Capacitor.getPlatform() !== 'android') return;
	const browserFetch = window.fetch,
		run = yield* FiberSet.makeRuntimePromise();
	const transport: typeof fetch = (input, init) => {
		if (
			(typeof input !== 'string' && !(input instanceof URL)) ||
			init?.method !== 'POST' ||
			typeof init.body !== 'string'
		)
			return browserFetch.call(window, input, init);
		const url = new URL(String(input), location.href);
		if (url.origin !== location.origin || !url.pathname.endsWith('/__bolt/act'))
			return browserFetch.call(window, input, init);
		return run(
			Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(init.body).pipe(
				Effect.flatMap((data) =>
					native(() =>
						CapacitorHttp.post({
							url: url.href,
							headers: {
								...Object.fromEntries(new Headers(init.headers)),
								Origin: location.origin
							},
							data,
							responseType: 'json',
							disableRedirects: true
						})
					)
				),
				Effect.map(
					(response) =>
						new Response(JSON.stringify(response.data), {
							status: response.status,
							headers: response.headers
						})
				)
			),
			init.signal == null ? {} : { signal: init.signal }
		);
	};
	window.fetch = transport;
	yield* Effect.addFinalizer(() =>
		Effect.sync(() => {
			if (window.fetch === transport) window.fetch = browserFetch;
		})
	);
});
