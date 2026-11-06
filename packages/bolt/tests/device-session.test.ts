// the device's platform-free half (shell/device-session.ts): which inbox notices are raised, taps navigating,
// the push endpoint stored and forgotten, the shell's notice service, and links out of the workspace.
import { afterEach, describe, expect, it, vi } from '@effect/vitest';
import { Effect, Exit, Queue, Scope, Stream } from 'effect';
import type { DeviceApi, DeviceNotice } from '../src/page/device.ts';
import type { PushBody } from '../src/protocol/schema.ts';
import {
	freshNotices,
	inboxNotices,
	deviceSession,
	openExternal
} from '../src/shell/device-session.ts';

const row = (id: string, read = false, link: { model: string; id: string } | null = null) => ({
	id,
	title: `T ${id}`,
	body: null,
	link,
	at: '2026-10-17T00:00:00.000Z',
	read
});

// files share a worker: a stubbed `document` left behind makes the next file's DOM libraries believe they run in a browser
afterEach(() => vi.unstubAllGlobals());

describe('the device environment', () => {
	it('raises only unread notices the previous answer did not hold, oldest first', () => {
		expect(freshNotices(null, inboxNotices({ rows: [row('a')] }))).toEqual([]);
		expect(
			freshNotices(
				new Set(['a']),
				inboxNotices({
					rows: [
						row('d'),
						row('c', false, { model: 'jobs', id: '1' }),
						row('b', true),
						row('a')
					]
				})
			)
		).toEqual([
			{ id: 'c', title: 'T c', body: null, path: '/inbox?record=jobs/1' },
			{ id: 'd', title: 'T d', body: null, path: '/inbox' }
		]);
		expect(inboxNotices({ rows: [{ id: 1 }, row('a')] })).toEqual([row('a')]);
		expect(inboxNotices('not an answer')).toEqual([]);
	});

	it.live('drives a shell environment for a signed-in member within its scope', () =>
		Effect.gen(function* () {
			vi.stubGlobal('document', { visibilityState: 'hidden', querySelector: () => null });
			vi.stubGlobal('location', { href: 'https://acme.example/inbox' });
			const shown: DeviceNotice[] = [],
				stored: PushBody[] = [];
			let open: ((path: string) => void) | undefined;
			const off = vi.fn(),
				start = vi.fn(async () => undefined),
				stop = vi.fn(async () => undefined),
				navigate = vi.fn();
			const keys = {
				topic: 'ai.norbital.app',
				environment: 'production' as const,
				teamId: 'TEAM123456'
			};
			const endpoint = 'ab'.repeat(32);
			const device: DeviceApi = {
				platform: 'ios',
				notifications: {
					status: async () => 'granted',
					request: async () => 'granted',
					openSettings: async () => undefined,
					show: async (notice) => {
						shown.push(notice);
					},
					onOpen: (listener) => {
						open = listener;
						return off;
					}
				},
				push: { register: async () => ({ kind: 'apns', endpoint, keys }) },
				notices: { start, stop }
			};
			const answers = yield* Queue.unbounded<unknown>();
			const scope = yield* Scope.make();
			const environment = yield* deviceSession(device, {
				inbox: Stream.fromQueue(answers),
				vapid: null,
				navigate,
				store: (body) =>
					Effect.sync(() => {
						stored.push(body);
					})
			}).pipe(Scope.provide(scope));
			yield* Queue.offer(answers, { rows: [row('a')] });
			yield* Queue.offer(answers, {
				rows: [row('b', false, { model: 'jobs', id: '1' }), row('a')]
			});
			yield* Effect.promise(() => vi.waitFor(() => expect(shown).toHaveLength(1)));
			expect(shown).toEqual([{ id: 'b', title: 'T b', body: null, path: '/inbox?record=jobs/1' }]);
			expect(stored).toEqual([{ kind: 'apns', endpoint, keys }]);
			expect(start).toHaveBeenCalledWith({ url: 'https://acme.example/__bolt/notices' });
			// a visible page shows its own toast instead
			vi.stubGlobal('document', { visibilityState: 'visible' });
			yield* Queue.offer(answers, { rows: [row('c'), row('b'), row('a')] });
			open?.('/inbox?record=jobs/1');
			expect(navigate).toHaveBeenCalledWith('/inbox?record=jobs/1');
			yield* environment.signOut;
			expect(stop).toHaveBeenCalledOnce();
			expect(stored[1]).toEqual({ endpoint, remove: true });
			yield* Scope.close(scope, Exit.void);
			expect(off).toHaveBeenCalledOnce();
		})
	);

	it.live('subscribes a browser unasked: permission on the first click, none when blocked', () =>
		Effect.gen(function* () {
			let click: (() => void) | undefined;
			const notice = { permission: 'default', requestPermission: vi.fn(async () => 'granted') };
			const raised = vi.fn();
			vi.stubGlobal(
				'Notification',
				class {
					static get permission() {
						return notice.permission;
					}
					static requestPermission = notice.requestPermission;
					constructor() {
						raised();
					}
				}
			);
			vi.stubGlobal('PushManager', class {});
			vi.stubGlobal('atob', (value: string) => Buffer.from(value, 'base64').toString('latin1'));
			vi.stubGlobal('location', { href: 'https://acme.example/inbox' });
			vi.stubGlobal('document', {
				visibilityState: 'hidden',
				querySelector: () => null,
				addEventListener: (_: string, listener: () => void) => {
					click = listener;
				},
				removeEventListener: () => undefined
			});
			const endpoint = 'https://push.example/1',
				keys = { p256dh: 'p', auth: 'a' };
			const subscribe = vi.fn(async () => ({ toJSON: () => ({ endpoint, keys }) }));
			vi.stubGlobal('navigator', {
				serviceWorker: { register: async () => ({ pushManager: { subscribe } }) }
			});
			const stored: PushBody[] = [];
			const answers = yield* Queue.unbounded<unknown>();
			const session = (scope: Scope.Closeable) =>
				deviceSession(
					{},
					{
						inbox: Stream.fromQueue(answers),
						vapid: 'AQAB',
						navigate: () => undefined,
						store: (body) => Effect.sync(() => void stored.push(body))
					}
				).pipe(Effect.provideService(Scope.Scope, scope));

			const scope = yield* Scope.make();
			const environment = yield* session(scope);
			yield* Effect.yieldNow;
			expect(notice.requestPermission).not.toHaveBeenCalled();
			expect(subscribe).not.toHaveBeenCalled();
			notice.permission = 'granted';
			click?.();
			expect(notice.requestPermission).toHaveBeenCalledOnce();
			yield* Effect.promise(() => vi.waitFor(() => expect(stored).toHaveLength(1)));
			expect(stored).toEqual([{ endpoint, keys }]);
			// the service worker raises it; the page would raise a second
			yield* Queue.offer(answers, { rows: [row('a')] });
			yield* Queue.offer(answers, { rows: [row('b'), row('a')] });
			yield* Effect.sleep(10);
			expect(raised).not.toHaveBeenCalled();
			yield* environment.signOut;
			expect(stored[1]).toEqual({ endpoint, remove: true });
			yield* Scope.close(scope, Exit.void);

			notice.permission = 'denied';
			click = undefined;
			const blocked = yield* Scope.make();
			yield* session(blocked);
			yield* Effect.yieldNow;
			expect(click).toBeUndefined();
			expect(subscribe).toHaveBeenCalledOnce();
			yield* Scope.close(blocked, Exit.void);
		})
	);

	it.effect('opens a link out of the workspace through the shell, else in the browser', () =>
		Effect.gen(function* () {
			const page = { href: 'https://acme.example/' };
			vi.stubGlobal('location', page);
			const openExternalUrl = vi.fn(async () => undefined);
			yield* openExternal(
				{ navigation: { openExternal: openExternalUrl } },
				'https://maps.example/x'
			);
			expect(openExternalUrl).toHaveBeenCalledWith('https://maps.example/x');
			expect(page.href).toBe('https://acme.example/');
			yield* openExternal({}, 'https://maps.example/y');
			expect(page.href).toBe('https://maps.example/y');
		})
	);
});
