import { Effect } from 'effect';
import { getErrorMessage } from '@norbital-ai/std';
import { haptic, type HapticKind } from '@norbital-ai/ui/utils/haptic';

/**
 * The device a workspace is open on, as one typed surface: `client.device`.
 *
 * Templates never touch `navigator` — the same page runs in a desktop tab, an installed phone
 * app and, later, a native shell, and only this seam knows which. Every capability answers with a
 * value or a `DeviceRefusal` a page can branch on (`denied` is a different screen from
 * `unavailable`); nothing here throws, and nothing here is guessed from a user agent.
 */
export type DeviceRefusal = Readonly<{
	readonly reason: 'unavailable' | 'denied' | 'timeout' | 'failed';
	readonly message: string;
}>;

export type DeviceLocation = Readonly<{
	readonly lat: number;
	readonly lng: number;
	readonly accuracyMeters: number;
	readonly at: number;
}>;

export type { HapticKind };

export type DeviceClient = Readonly<{
	/** One fix, foreground only; `highAccuracy` asks for GPS and costs a few seconds and some battery. */
	readonly location: (options?: {
		readonly timeoutMs?: number;
		readonly highAccuracy?: boolean;
	}) => Effect.Effect<DeviceLocation, DeviceRefusal>;
	/** The OS share sheet; `unavailable` in a desktop browser without one. */
	readonly share: (input: {
		readonly title?: string;
		readonly text?: string;
		readonly url?: string;
	}) => Effect.Effect<void, DeviceRefusal>;
	readonly copy: (text: string) => Effect.Effect<void, DeviceRefusal>;
	/** A tick the finger feels where the device has a motor; see `@norbital-ai/ui/utils/haptic`. */
	readonly haptic: (kind?: HapticKind) => void;
	readonly online: () => boolean;
}>;

const refusal = (reason: DeviceRefusal['reason'], message: string): DeviceRefusal => ({
	reason,
	message
});

const inBrowser = (): boolean => 'navigator' in globalThis;

const geolocationRefusal = (error: GeolocationPositionError): DeviceRefusal =>
	error.code === error.PERMISSION_DENIED
		? refusal('denied', 'Location access was refused')
		: error.code === error.TIMEOUT
			? refusal('timeout', 'The device could not fix a location in time')
			: refusal('unavailable', error.message || 'Location is unavailable on this device');

export const deviceClient: DeviceClient = {
	location: ({ timeoutMs = 10_000, highAccuracy = false } = {}) =>
		!inBrowser() || !('geolocation' in navigator)
			? Effect.fail(refusal('unavailable', 'This device reports no location'))
			: Effect.callback<DeviceLocation, DeviceRefusal>((resume) => {
					navigator.geolocation.getCurrentPosition(
						({ coords, timestamp }) =>
							resume(
								Effect.succeed({
									lat: coords.latitude,
									lng: coords.longitude,
									accuracyMeters: coords.accuracy,
									at: timestamp
								})
							),
						(error) => resume(Effect.fail(geolocationRefusal(error))),
						{ enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: 0 }
					);
				}),
	share: (input) =>
		!inBrowser() || !('share' in navigator)
			? Effect.fail(refusal('unavailable', 'This browser has no share sheet'))
			: Effect.tryPromise({
					try: () => navigator.share(input),
					catch: (cause) =>
						cause instanceof DOMException && cause.name === 'AbortError'
							? refusal('denied', 'Sharing was cancelled')
							: refusal('failed', getErrorMessage(cause))
				}),
	copy: (text) =>
		!inBrowser() || navigator.clipboard === undefined
			? Effect.fail(refusal('unavailable', 'This browser exposes no clipboard'))
			: Effect.tryPromise({
					try: () => navigator.clipboard.writeText(text),
					catch: (cause) => refusal('denied', getErrorMessage(cause))
				}),
	haptic,
	online: () => !inBrowser() || navigator.onLine
};
