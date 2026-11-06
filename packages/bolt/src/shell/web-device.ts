// The web shell's device: the browser's own notifications and web push. Bolt uses them for whatever an installed
// shell's device (`window.boltDevice`) does not provide.
import { Effect, Schema } from 'effect';
import type { DeviceNotifications } from '../page/device.ts';
import { PushBody } from '../protocol/schema.ts';
import { SW } from '../protocol/wire.ts';
import { based } from './nav.ts';

export class DeviceFailure extends Schema.TaggedError<DeviceFailure>()('DeviceFailure', {
	operation: Schema.String,
	cause: Schema.Defect()
}) {}
export const attempt = <A>(operation: string, f: () => Promise<A>) =>
	Effect.tryPromise({ try: f, catch: (cause) => new DeviceFailure({ operation, cause }) });
export const quietly = <A, E>(effect: Effect.Effect<A, E>) =>
	effect.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);

/** The browser's notifications, raised by the page: a click focuses it and opens the notice's path. */
export const webNotifications = (): DeviceNotifications => {
	const listeners = new Set<(path: string) => void>();
	return {
		show: async (notice) => {
			if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
			const shown = new Notification(notice.title, {
				tag: notice.id,
				...(notice.body === null ? {} : { body: notice.body })
			});
			shown.onclick = () => {
				window.focus();
				for (const listener of listeners) listener(notice.path);
			};
		},
		onOpen: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
	};
};

/** Whether this browser can take a web push subscription. */
export const webPushable = (): boolean =>
	typeof navigator !== 'undefined' &&
	'serviceWorker' in navigator &&
	typeof PushManager !== 'undefined';
export const registration = (value: unknown) =>
	Schema.decodeUnknownEffect(PushBody)(value).pipe(
		Effect.flatMap((body) =>
			'remove' in body
				? Effect.fail(new DeviceFailure({ operation: 'push.register', cause: body }))
				: Effect.succeed(body)
		)
	);
/** The browser's notification permission: browsers prompt only on a gesture, so an unanswered one asks on the first click. */
const permission = Effect.callback<NotificationPermission, DeviceFailure>((resume) => {
	if (Notification.permission !== 'default') return resume(Effect.succeed(Notification.permission));
	const ask = () => {
		const answer = Notification.requestPermission();
		resume(attempt('notifications.request', () => answer));
	};
	document.addEventListener('click', ask, { once: true, capture: true });
	return Effect.sync(() => document.removeEventListener('click', ask, { capture: true }));
});
/** This browser's web push subscription under the host's VAPID key, once it has notification permission. */
export const webPush = Effect.fn('shell.webPush')(function* (key: string) {
	const answer = yield* permission;
	if (answer !== 'granted')
		return yield* Effect.fail(new DeviceFailure({ operation: 'push.permission', cause: answer }));
	const worker = yield* attempt('serviceWorker.register', () =>
		navigator.serviceWorker.register(based(SW), { scope: based('/') })
	);
	const raw = yield* Effect.try({
		try: () => atob(key.replace(/-/g, '+').replace(/_/g, '/')),
		catch: (cause) => new DeviceFailure({ operation: 'push.key', cause })
	});
	const subscription = yield* attempt('pushManager.subscribe', () =>
		worker.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0))
		})
	);
	return yield* registration(subscription.toJSON());
});
