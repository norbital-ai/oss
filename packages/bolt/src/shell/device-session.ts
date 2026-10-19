// The device session, platform-free: a signed-in member's new notices raised on the device while the page is hidden,
// a tapped one followed, this device's push endpoint stored, the shell's background notice service run, and links
// outside the workspace opened by the shell. Whatever the installed device lacks, the web shell's stands in.
import { Effect, Option, Schema, Stream } from 'effect';
import type { DeviceApi, DeviceNotice, PushRegistration } from '../page/device.ts';
import { NoticeRow, type PushBody } from '../protocol/schema.ts';
import { PATHS, noticePath } from '../protocol/wire.ts';
import { based } from './nav.ts';
import {
	attempt,
	quietly,
	registration,
	webNotifications,
	webPush,
	webPushable
} from './web-device.ts';

const noticeRows = Schema.decodeUnknownOption(Schema.Struct({ rows: Schema.Array(Schema.Json) }));
const noticeRow = Schema.decodeUnknownOption(NoticeRow);
/** A live inbox answer's notices; an answer that is not one has none. */
export const inboxNotices = (value: unknown): readonly NoticeRow[] =>
	Option.match(noticeRows(value), {
		onNone: () => [],
		onSome: (page) => page.rows.flatMap((row) => Option.toArray(noticeRow(row)))
	});
/** The unread notices of an answer that the previous answer (`seen`, its ids) did not hold, oldest first. */
export const freshNotices = (
	seen: ReadonlySet<string> | null,
	rows: readonly NoticeRow[]
): readonly DeviceNotice[] =>
	seen === null
		? []
		: rows
				.filter((row) => !row.read && !seen.has(row.id))
				.map((row) => ({
					id: row.id,
					title: row.title,
					body: row.body,
					path: noticePath(row.link)
				}))
				.reverse();

/** Opens a URL outside the workspace: through the shell when it has a way, otherwise in this browser. */
export const openExternal = (device: DeviceApi, href: string): Effect.Effect<void> => {
	const navigation = device.navigation;
	const browser = Effect.sync(() => {
		location.href = href;
	});
	return navigation === undefined
		? browser
		: attempt('navigation.openExternal', () => navigation.openExternal(href)).pipe(
				Effect.catch(() => browser)
			);
};

/**
 * A signed-in staff member's Device for the page scope: taps navigate; each new unread notice of the live
 * `inbox` is raised while the page is hidden (a visible page shows its own toast); the device's push endpoint is stored
 * (a shell's `push`, else web push once the browser already granted notifications); the shell's notice
 * service starts. `signOut` stops the service and forgets the endpoint, before the session ends.
 */
export const deviceSession = Effect.fn('shell.deviceSession')(function* (
	device: DeviceApi,
	options: {
		readonly inbox: Stream.Stream<unknown, unknown>;
		/** The host's VAPID key, or `null` when it sends no web push. */
		readonly vapid: string | null;
		readonly navigate: (path: string) => void;
		readonly store: (body: PushBody) => Effect.Effect<void, unknown>;
	}
) {
	const notifications = device.notifications ?? webNotifications();
	yield* Effect.acquireRelease(
		Effect.sync(() => notifications.onOpen(options.navigate)),
		(off) => Effect.sync(off)
	);
	let seen: ReadonlySet<string> | null = null;
	yield* options.inbox.pipe(
		Stream.runForEach((value) => {
			const rows = inboxNotices(value),
				fresh = freshNotices(seen, rows);
			seen = new Set(rows.map((row) => row.id));
			return document.visibilityState === 'visible'
				? Effect.void
				: Effect.forEach(
						fresh,
						(notice) => quietly(attempt('notifications.show', () => notifications.show(notice))),
						{ discard: true }
					);
		}),
		quietly,
		Effect.forkScoped
	);
	const push = device.push,
		vapid = options.vapid;
	const register: Effect.Effect<PushRegistration, unknown> | null =
		push !== undefined
			? attempt('push.register', () => push.register()).pipe(Effect.flatMap(registration))
			: vapid !== null &&
				  webPushable() &&
				  typeof Notification !== 'undefined' &&
				  Notification.permission === 'granted'
				? webPush(vapid)
				: null;
	let endpoint: string | null = null;
	if (register !== null)
		yield* register.pipe(
			Effect.tap(options.store),
			Effect.tap((body) =>
				Effect.sync(() => {
					endpoint = body.endpoint;
				})
			),
			quietly,
			Effect.forkScoped
		);
	const notices = device.notices;
	if (notices !== undefined)
		yield* quietly(
			attempt('notices.start', () =>
				notices.start({ url: new URL(based(PATHS.notices), location.href).href })
			)
		).pipe(Effect.forkScoped);
	return {
		signOut: Effect.gen(function* () {
			if (notices !== undefined) yield* quietly(attempt('notices.stop', () => notices.stop()));
			if (endpoint !== null) yield* quietly(options.store({ endpoint, remove: true }));
		})
	};
});
