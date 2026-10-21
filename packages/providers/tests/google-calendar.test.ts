// Google Calendar as the `calendar` driver over a fake fetch: the instance's own OAuth sign-in (the definition's client
// from env, PKCE, its redirect URI), driver feed pages (a full read a snapshot, a sync token the cursor, 410 a fresh
// snapshot), watches sealed before they register and renewed by replacement, and notifications acknowledged only once
// the engine queued the read.
import { describe, expect, it } from '@effect/vitest';
import { Effect, Exit, Fiber, FiberSet, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import type { DriverEvent, DriverOpen, DriverPage, Json } from '@norbital-ai/bolt/engine';
import { googleCalendar } from '../src/google-calendar/index.ts';
import { fakeFetch, host, json, until, type Host, type HostOptions, type Route } from './kit.ts';

const NOW = Date.parse('2026-10-12T08:00:00Z');
const HOOK = 'https://host.example/acme/hooks/integration/desk',
	REDIRECT = 'https://host.example/acme/hooks/oauth/callback';
const READ = 'https://www.googleapis.com/auth/calendar.readonly',
	WRITE = 'https://www.googleapis.com/auth/calendar.events';
const TOKEN = {
	access: 'secret-access-token',
	refresh: 'refresh-1',
	exp: NOW + 3_600_000,
	scope: `${READ} ${WRITE}`
};
const definition: DriverOpen['definition'] = {
	description: 'Calendars',
	driver: 'calendar',
	oauth: { client: 'GOOGLE_CLIENT', secret: 'GOOGLE_SECRET' },
	feeds: {
		events: {
			into: 'calendar_entries',
			key: ['external_id'],
			from: 'driver',
			partitions: 'calendars'
		}
	}
};
const fixture = Effect.fn('CalendarTest.fixture')(function* (
	routes: Route[] = [],
	stored: { [name: string]: Json } = { token: TOKEN },
	webhookUrl = HOOK,
	beforeWrite?: HostOptions['write']
) {
	yield* TestClock.setTime(NOW);
	let queueFails = false,
		stateFails = false;
	const fetch = fakeFetch(routes);
	const h = yield* host(googleCalendar(), fetch, stored, {
		webhookUrl,
		redirectUrl: REDIRECT,
		definition,
		configuration: { calendars: ['visits@example.com'] },
		secrets: { GOOGLE_CLIENT: 'client-1', GOOGLE_SECRET: 'shh' },
		write: async (changes) => {
			if (stateFails && changes.has('state')) throw new Error('sealed store unavailable');
			await beforeWrite?.(changes);
		},
		emit: async (e) => {
			if (queueFails && e.kind === 'invalidate') throw new Error('queue unavailable');
		}
	});
	return {
		h,
		link: h.link,
		fetch,
		now: (value: number) => TestClock.setTime(value),
		queueFails: (value: boolean) => {
			queueFails = value;
		},
		stateFails: (value: boolean) => {
			stateFails = value;
		}
	};
});
const read = (
	f: { link: Host['link'] },
	cursor: Json | null,
	partition = 'visits@example.com'
): Effect.Effect<DriverPage, import('../src/errors.ts').ProviderFailure> =>
	f.link.read!('events', partition, cursor);
const invalidations = (h: Host) =>
	h.events.filter(
		(e): e is Extract<DriverEvent, { kind: 'invalidate' }> => e.kind === 'invalidate'
	);
const states = (h: Host) => h.writes.flatMap((w) => (w.has('state') ? [w.get('state')] : []));
const WatchRequest = Schema.fromJsonString(
	Schema.Struct({ id: Schema.String, token: Schema.String })
);
const watchResponse: Route = (call) =>
	call.url.endsWith('/events/watch')
		? json({
				id: Schema.decodeUnknownSync(WatchRequest)(call.body).id,
				resourceId: 'google-resource',
				expiration: String(NOW + 3_600_000)
			})
		: undefined;
const notification = (
	watch: { id: string; token: string },
	message = '1',
	state = 'sync',
	resource = 'google-resource',
	extra: Record<string, string> = {}
) =>
	new Request(HOOK, {
		method: 'POST',
		headers: {
			'x-goog-channel-id': watch.id,
			'x-goog-channel-token': watch.token,
			'x-goog-resource-id': resource,
			'x-goog-resource-state': state,
			'x-goog-message-number': message,
			...extra
		}
	});
const registration = (
	f: Effect.Success<ReturnType<typeof fixture>>,
	index = 0
): { id: string; token: string } => {
	const call = f.fetch.calls.filter((call) => call.url.endsWith('/events/watch'))[index];
	if (!call) throw new Error('watch was not registered');
	const value = Schema.decodeUnknownSync(WatchRequest)(call.body);
	return { id: value.id, token: value.token };
};

describe('the Google Calendar link', () => {
	it.effect('discovers every page of calendars and sends the token only to Google', () =>
		Effect.gen(function* () {
			const f = yield* fixture([
				(call) =>
					call.url.includes('/calendarList')
						? json(
								new URL(call.url).searchParams.has('pageToken')
									? { items: [{ id: 'team@example.com', summary: 'Team' }] }
									: {
											items: [{ id: 'visits@example.com', summary: 'Visits', primary: true }],
											nextPageToken: 'opaque-page'
										}
							)
						: undefined
			]);
			expect(yield* f.link.discover!()).toEqual([
				{ id: 'visits@example.com', label: 'Visits' },
				{ id: 'team@example.com', label: 'Team' }
			]);
			expect(
				f.fetch.calls.every((call) => new URL(call.url).origin === 'https://www.googleapis.com')
			).toBe(true);
			expect(
				f.fetch.calls.every((call) => new URL(call.url).searchParams.get('showHidden') === 'true')
			).toBe(true);
			expect(f.fetch.calls[0]?.headers['authorization']).toBe('Bearer secret-access-token');
			expect(f.h.status).toEqual({ state: 'connected', account: null });
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect(
		'a full read is a snapshot: its pages carry the page token, its last the sync token; times keep their zones; cancellations are items',
		() =>
			Effect.gen(function* () {
				const event = {
					id: 'event-1',
					summary: 'Visit',
					htmlLink: 'https://calendar.google.com/e1',
					start: { date: '2026-10-12' },
					end: { dateTime: '2026-10-13T09:00:00+09:00', timeZone: 'Asia/Tokyo' }
				};
				const f = yield* fixture([
					(call) =>
						call.url.includes('/events?')
							? json(
									new URL(call.url).searchParams.has('pageToken')
										? { items: [{ id: 'event-2', status: 'cancelled' }], nextSyncToken: 'new-sync' }
										: { items: [event], nextPageToken: 'next-page' }
								)
							: undefined
				]);
				const first = yield* read(f, null);
				expect(first).toEqual({
					items: [
						{
							id: 'event-1',
							summary: 'Visit',
							description: null,
							location: null,
							url: 'https://calendar.google.com/e1',
							status: 'confirmed',
							start: { date: '2026-10-12' },
							end: { at: '2026-10-13T00:00:00.000Z', zone: 'Asia/Tokyo' },
							source: event
						}
					],
					cursor: { page: 'next-page' },
					more: true
				});
				expect(yield* read(f, first.cursor)).toEqual({
					items: [
						{
							id: 'event-2',
							summary: null,
							description: null,
							location: null,
							url: null,
							status: 'cancelled',
							start: { date: '1970-01-01' },
							end: { date: '1970-01-01' },
							source: { id: 'event-2', status: 'cancelled' }
						}
					],
					cursor: { sync: 'new-sync' },
					more: false,
					snapshot: 'end'
				});
				expect(new URL(f.fetch.calls[1]!.url).searchParams.get('pageToken')).toBe('next-page');
				expect(f.h.writes).toEqual([]);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect('an incremental read passes the sync token on every page and is no snapshot', () =>
		Effect.gen(function* () {
			const f = yield* fixture([
				(call) =>
					json(
						new URL(call.url).searchParams.has('pageToken')
							? { items: [], nextSyncToken: 'newer' }
							: { items: [], nextPageToken: 'p2' }
					)
			]);
			expect(yield* read(f, { sync: 'old-sync' })).toEqual({
				items: [],
				cursor: { sync: 'old-sync', page: 'p2' },
				more: true
			});
			expect(yield* read(f, { sync: 'old-sync', page: 'p2' })).toEqual({
				items: [],
				cursor: { sync: 'newer' },
				more: false
			});
			expect(f.fetch.calls.map((call) => new URL(call.url).searchParams.get('syncToken'))).toEqual([
				'old-sync',
				'old-sync'
			]);
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect(
		'expands recurring occurrences, keeps hidden invitations and deleted events, and never bounds the window',
		() =>
			Effect.gen(function* () {
				const event = {
					id: 'series_20261012T010000Z',
					recurringEventId: 'series',
					status: 'tentative',
					start: { dateTime: '2026-10-13T11:00:00+09:00', timeZone: 'Asia/Tokyo' },
					end: { dateTime: '2026-10-13T12:00:00+09:00', timeZone: 'Asia/Tokyo' },
					attendees: [{ email: 'client@example.test' }],
					recurrence: ['RRULE:FREQ=WEEKLY']
				};
				const f = yield* fixture([() => json({ items: [event], nextSyncToken: 'current' })]);
				expect((yield* read(f, null)).items).toMatchObject([
					{
						id: event.id,
						status: 'tentative',
						start: { at: '2026-10-13T02:00:00.000Z', zone: 'Asia/Tokyo' },
						source: event
					}
				]);
				yield* read(f, { sync: 'previous' });
				for (const call of f.fetch.calls) {
					const query = new URL(call.url).searchParams;
					expect([
						query.get('singleEvents'),
						query.get('showDeleted'),
						query.get('showHiddenInvitations')
					]).toEqual(['true', 'true', 'true']);
					expect(query.has('timeMin') || query.has('timeMax')).toBe(false);
				}
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect(
		'an expired sync token is retained: false, so the engine reads a fresh snapshot; nothing is deleted here',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture([() => json({}, 410)]);
				expect(yield* read(f, { sync: 'expired' })).toEqual({
					items: [],
					cursor: null,
					more: false,
					retained: false
				});
				expect(f.h.writes).toEqual([]);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect.each([
		{ items: [null], nextSyncToken: 's' },
		{ items: [{}], nextSyncToken: 's' },
		{ items: [{ id: 'missing-time' }], nextSyncToken: 's' },
		{
			items: [
				{
					id: 'unzoned',
					start: { dateTime: '2026-10-13T09:00:00' },
					end: { dateTime: '2026-10-13T10:00:00' }
				}
			],
			nextSyncToken: 's'
		},
		{
			items: [{ id: 'invalid-day', start: { date: '2026-02-31' }, end: { date: '2026-03-01' } }],
			nextSyncToken: 's'
		},
		{ items: [], nextPageToken: 'p', nextSyncToken: 's' },
		{ items: [] }
	])('refuses a malformed page before the engine can commit it', (body) =>
		Effect.gen(function* () {
			const f = yield* fixture([() => json(body)]);
			expect(yield* Effect.flip(read(f, null))).toBeDefined();
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect('a definition without partitions reads the primary calendar', () =>
		Effect.gen(function* () {
			const f = yield* fixture([() => json({ items: [], nextSyncToken: 's' })]);
			yield* read(f, null, '');
			expect(new URL(f.fetch.calls[0]!.url).pathname).toBe('/calendar/v3/calendars/primary/events');
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect(
		'seals the pending watch before registering it, and authenticates its first notification before the answer',
		() =>
			Effect.gen(function* () {
				let f: Effect.Success<ReturnType<typeof fixture>> | undefined;
				const run = yield* FiberSet.makeRuntimePromise<never>();
				f = yield* fixture([
					(call) => {
						if (!call.url.endsWith('/events/watch')) return undefined;
						return (async () => {
							const watch = Schema.decodeUnknownSync(WatchRequest)(call.body);
							if (f === undefined) throw new Error('fixture has not opened');
							expect(JSON.stringify(states(f.h))).toContain(watch.id);
							expect(await run(f.link.webhook!(notification(watch)))).toMatchObject({
								status: 204
							});
							return json({
								id: watch.id,
								resourceId: 'google-resource',
								expiration: String(NOW + 3_600_000)
							});
						})();
					}
				]);
				expect(yield* f.link.renew!()).toBe(new Date(NOW + 3_300_000).toISOString());
				// the first notification, then the registration's reconciliation
				expect(invalidations(f.h)).toEqual([
					{ kind: 'invalidate', feed: 'events', partition: 'visits@example.com' },
					{ kind: 'invalidate', feed: 'events', partition: 'visits@example.com' }
				]);
				expect(JSON.stringify(f.h.statuses)).not.toMatch(/secret|google-resource|token/);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect(
		'authenticates known watches by their token and resource; each notification asks the engine to read that calendar',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture([watchResponse]);
				yield* f.link.renew!();
				const watch = registration(f);
				const before = invalidations(f.h).length;
				for (const message of ['9007199254740992', '9007199254740993'])
					expect(
						yield* f.link.webhook!(
							notification(watch, message, 'exists', 'google-resource', {
								'x-goog-resource-uri': 'https://evil.example/secrets'
							})
						)
					).toMatchObject({ status: 204 });
				expect(invalidations(f.h).length).toBe(before + 2);
				expect(f.fetch.calls).toHaveLength(1);
				for (const request of [
					notification({ ...watch, token: 'wrong' }),
					notification({ ...watch, id: 'unknown' }),
					notification(watch, '2', 'exists', 'another-resource'),
					notification(watch, '1.5', 'exists')
				])
					expect(yield* f.link.webhook!(request)).toMatchObject({ status: 403 });
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect(
		'acknowledges a notification only after the engine queued the read, so Google notifies again',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture([watchResponse]);
				yield* f.link.renew!();
				const request = () => notification(registration(f), '22', 'exists');
				f.queueFails(true);
				expect(yield* Effect.flip(f.link.webhook!(request()))).toMatchObject({
					message: expect.stringContaining('queue unavailable')
				});
				f.queueFails(false);
				expect(yield* f.link.webhook!(request())).toMatchObject({ status: 204 });
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect('renews by replacement while accepting both live watches, and never polls events', () =>
		Effect.gen(function* () {
			const f: Effect.Success<ReturnType<typeof fixture>> = yield* fixture([
				(call) =>
					call.url.endsWith('/events/watch')
						? json({
								id: Schema.decodeUnknownSync(WatchRequest)(call.body).id,
								resourceId: 'google-resource',
								expiration: String(NOW + (f.fetch.calls.length === 1 ? 3_600_000 : 7_200_000))
							})
						: undefined
			]);
			yield* f.link.renew!();
			yield* f.now(NOW + 3_350_000);
			yield* f.link.renew!();
			const first = registration(f),
				second = registration(f, 1);
			expect(first.id).not.toBe(second.id);
			for (const watch of [first, second])
				expect(yield* f.link.webhook!(notification(watch, '20', 'exists'))).toMatchObject({
					status: 204
				});
			expect(f.fetch.calls.every((call) => call.url.endsWith('/events/watch'))).toBe(true);
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect('restores the watches after a restart and stops them on unpair', () =>
		Effect.gen(function* () {
			const first = yield* fixture([watchResponse]);
			yield* first.link.renew!();
			const watch = registration(first);
			yield* first.link.close ?? Effect.void;
			const second = yield* fixture(
				[
					(call) =>
						call.url.endsWith('/channels/stop') ? new Response(null, { status: 204 }) : undefined
				],
				Object.fromEntries(first.h.values)
			);
			expect(yield* second.link.webhook!(notification(watch, '33', 'exists'))).toMatchObject({
				status: 204
			});
			yield* second.link.unpair!();
			expect(second.fetch.calls.map((call) => new URL(call.url).pathname)).toEqual([
				'/calendar/v3/channels/stop',
				'/revoke'
			]);
			expect(second.h.values.get('state')).toEqual({ watches: [] });
			expect(yield* second.link.webhook!(notification(watch, '34', 'exists'))).toMatchObject({
				status: 403
			});
			yield* second.link.close ?? Effect.void;
		})
	);
	it.effect(
		'registers no watch when sealing its pending identity fails, and recovers without a phantom registration',
		() =>
			Effect.gen(function* () {
				const f = yield* fixture([watchResponse]);
				f.stateFails(true);
				expect(yield* Effect.flip(f.link.renew!())).toMatchObject({
					message: expect.stringContaining('sealed store unavailable')
				});
				expect(f.fetch.calls).toEqual([]);
				f.stateFails(false);
				yield* f.link.renew!();
				expect(f.fetch.calls).toHaveLength(1);
				expect(f.h.values.get('state')).toMatchObject({
					watches: [{ phase: 'active', reconcile: false }]
				});
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect("keeps a replacement's reconciliation across a queue failure and a restart", () =>
		Effect.gen(function* () {
			const first = yield* fixture([watchResponse]);
			first.queueFails(true);
			expect(yield* Effect.flip(first.link.renew!())).toMatchObject({
				message: expect.stringContaining('queue unavailable')
			});
			expect(first.h.values.get('state')).toMatchObject({
				watches: [{ phase: 'active', reconcile: true }]
			});
			yield* first.link.close ?? Effect.void;
			const restored = yield* fixture([], Object.fromEntries(first.h.values));
			yield* restored.link.renew!();
			expect(restored.fetch.calls).toEqual([]);
			expect(invalidations(restored.h)).toHaveLength(1);
			expect(restored.h.values.get('state')).toMatchObject({ watches: [{ reconcile: false }] });
			yield* restored.link.close ?? Effect.void;
		})
	);
	it.effect('keeps a pending registration for recovery after a lost response', () =>
		Effect.gen(function* () {
			const f = yield* fixture([
				(call) => {
					if (call.url.endsWith('/events/watch')) throw new Error('response lost');
					return undefined;
				}
			]);
			expect(yield* Effect.flip(f.link.renew!())).toMatchObject({
				message: expect.stringMatching(/operation failed/)
			});
			expect(JSON.stringify(f.h.values.get('state'))).toContain('pending');
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect('registers no webhook on a loopback dev host and refuses plain http elsewhere', () =>
		Effect.gen(function* () {
			const local = yield* fixture(
				[() => json({ items: [], nextSyncToken: 'local' })],
				{ token: TOKEN },
				'http://127.0.0.1:54337/hooks/integration/desk'
			);
			expect(yield* local.link.renew!()).toBe(new Date(NOW + 300_000).toISOString());
			expect(invalidations(local.h)).toEqual([
				{ kind: 'invalidate', feed: 'events', partition: 'visits@example.com' }
			]);
			expect(local.fetch.calls).toHaveLength(0);
			expect(yield* read(local, null)).toMatchObject({
				cursor: { sync: 'local' },
				snapshot: 'end'
			});
			yield* local.link.close ?? Effect.void;
			expect(yield* local.link.renew!()).toBeNull();
			expect(invalidations(local.h)).toHaveLength(1);
			const remote = yield* fixture(
				[],
				{ token: TOKEN },
				'http://insecure.example/hooks/integration/desk'
			);
			expect(yield* Effect.flip(remote.link.renew!())).toMatchObject({
				message: expect.stringMatching('HTTPS')
			});
			yield* remote.link.close ?? Effect.void;
		})
	);
	it.effect('retries a failed local refresh enqueue without registering a remote watch', () =>
		Effect.gen(function* () {
			const local = yield* fixture(
				[],
				{ token: TOKEN },
				'http://localhost:54337/hooks/integration/desk'
			);
			local.queueFails(true);
			expect(yield* Effect.flip(local.link.renew!())).toMatchObject({
				message: expect.stringContaining('queue unavailable')
			});
			local.queueFails(false);
			expect(yield* local.link.renew!()).toBe(new Date(NOW + 300_000).toISOString());
			expect(invalidations(local.h)).toHaveLength(1);
			expect(local.fetch.calls).toHaveLength(0);
			yield* local.link.close ?? Effect.void;
		})
	);
	it.effect('refreshes a local workspace hostname without registering a watch', () =>
		Effect.gen(function* () {
			const local = yield* fixture(
				[],
				{ token: TOKEN },
				'http://norbital_hq.localhost:5173/hooks/integration/desk'
			);
			expect(yield* local.link.renew!()).toBe(new Date(NOW + 300_000).toISOString());
			expect(invalidations(local.h)).toEqual([
				{ kind: 'invalidate', feed: 'events', partition: 'visits@example.com' }
			]);
			expect(local.fetch.calls).toHaveLength(0);
			yield* local.link.close ?? Effect.void;
		})
	);
});

describe('the Google Calendar sign-in', () => {
	const google =
		(token: (body: URLSearchParams) => Response): Route =>
		(call) =>
			call.url === 'https://oauth2.googleapis.com/token'
				? token(new URLSearchParams(call.body))
				: call.url.includes('/calendarList')
					? json({ items: [{ id: 'ana@example.com', summary: 'Ana', primary: true }] })
					: undefined;
	const authorize = (h: Host) => new URL(h.pairing!.value!);

	it.effect(
		"publishes the authorize URL of the definition's client: PKCE, offline access, the host's one redirect URI",
		() =>
			Effect.gen(function* () {
				const f = yield* fixture([], {});
				expect(yield* f.link.renew!()).toBeNull(); // not signed in: nothing to renew
				yield* f.link.pair!({});
				expect(f.h.status).toEqual({ state: 'pairing' });
				const url = authorize(f.h);
				expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
				expect(Object.fromEntries(url.searchParams)).toMatchObject({
					response_type: 'code',
					client_id: 'client-1',
					redirect_uri: REDIRECT,
					scope: `${READ} ${WRITE}`,
					access_type: 'offline',
					prompt: 'consent',
					code_challenge_method: 'S256'
				});
				// while it waits, the renew loop looks again shortly
				expect(yield* f.link.renew!()).toBe(new Date(NOW + 15_000).toISOString());
				expect(f.h.writes).toEqual([]);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect(
		'a forged state is refused; the code is exchanged with the verifier, sealed with the account, and every calendar reads its first snapshot',
		() =>
			Effect.gen(function* () {
				let exchanged: URLSearchParams | null = null;
				const f = yield* fixture(
					[
						google((b) => {
							exchanged = b;
							return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
						})
					],
					{}
				);
				yield* f.link.pair!({});
				const state = authorize(f.h).searchParams.get('state')!;
				expect(
					(yield* f.link.webhook!(new Request(`${REDIRECT}?state=forged&code=c1`))).status
				).toBe(400);
				expect(exchanged).toBeNull();
				const res = yield* f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
				expect(res.status).toBe(200);
				expect(Object.fromEntries(exchanged!)).toMatchObject({
					grant_type: 'authorization_code',
					code: 'c1',
					redirect_uri: REDIRECT,
					client_id: 'client-1',
					client_secret: 'shh',
					code_verifier: expect.stringMatching(/^[\w-]{43}$/)
				});
				expect(f.h.values.get('token')).toMatchObject({ access: 'at-1', refresh: 'rt-1' });
				expect(f.h.values.get('state')).toEqual({ watches: [], account: 'ana@example.com' });
				expect(f.h.status).toEqual({ state: 'connected', account: 'ana@example.com' });
				expect(invalidations(f.h)).toEqual([
					{ kind: 'invalidate', feed: 'events', partition: 'visits@example.com' }
				]);
				// A consumed callback still reports its completion without exchanging its code again.
				expect(
					(yield* f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`))).status
				).toBe(200);
				expect(f.fetch.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect(
		'completes concurrent duplicate callbacks once and resets only the pairing attempt',
		() =>
			Effect.gen(function* () {
				const entered = Promise.withResolvers<void>(),
					allow = Promise.withResolvers<void>();
				yield* Effect.addFinalizer(() => Effect.sync(() => allow.resolve()));
				const f = yield* fixture(
					[
						(call) => {
							if (call.url !== 'https://oauth2.googleapis.com/token') return undefined;
							entered.resolve();
							return allow.promise.then(() =>
								json({ access_token: 'at-1', refresh_token: 'rt-1' })
							);
						},
						google(() => json({}))
					],
					{}
				);
				yield* f.link.pair!({});
				const state = authorize(f.h).searchParams.get('state')!;
				const callback = (nonce = state) =>
					f.link.webhook!(new Request(`${REDIRECT}?state=${nonce}&code=c1`));
				const abandoned = yield* Effect.forkChild(callback());
				yield* Effect.promise(() => entered.promise);
				const running = yield* Effect.forkChild(
					Effect.all([callback(), callback()], { concurrency: 2 })
				);
				yield* Fiber.interrupt(abandoned);
				expect(f.fetch.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
				allow.resolve();
				const responses = yield* Fiber.join(running);
				const bodies = yield* Effect.promise(() => Promise.all(responses.map((r) => r.text())));
				expect(responses.map((r) => r.status)).toEqual([200, 200]);
				expect(bodies).toEqual([
					'Signed in. You can close this window.',
					'Signed in. You can close this window.'
				]);
				const repeated = yield* callback();
				expect(yield* Effect.promise(() => repeated.text())).toBe(bodies[0]);
				expect(f.h.writes.filter((write) => write.has('token'))).toHaveLength(1);
				expect(invalidations(f.h)).toHaveLength(1);
				expect(f.h.status).toEqual({ state: 'connected', account: 'ana@example.com' });
				expect((yield* callback('forged')).status).toBe(400);
				yield* f.now(NOW + 11 * 60_000);
				expect((yield* callback()).status).toBe(400);
				const sealed = f.h.values.get('token');
				yield* f.link.pair!({});
				const next = authorize(f.h).searchParams.get('state')!;
				expect((yield* callback()).status).toBe(400);
				expect(f.h.values.get('token')).toEqual(sealed);
				yield* f.link.unpair!();
				expect((yield* callback(next)).status).toBe(400);
				expect(f.fetch.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect('replays a refused callback without exchanging the consumed code again', () =>
		Effect.gen(function* () {
			const f = yield* fixture([google(() => json({ error: 'invalid_grant' }, 400))], {});
			yield* f.link.pair!({});
			const state = authorize(f.h).searchParams.get('state')!;
			const callback = () =>
				f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=refused`));
			const first = yield* callback();
			const body = yield* Effect.promise(() => first.text());
			const again = yield* callback();
			expect(again.status).toBe(400);
			expect(yield* Effect.promise(() => again.text())).toBe(body);
			expect(f.fetch.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
			expect(f.h.statuses.filter((status) => status.state === 'error')).toHaveLength(1);
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect(
		'disconnecting during a callback prevents the old attempt from restoring the link afterward',
		() =>
			Effect.gen(function* () {
				const entered = Promise.withResolvers<void>(),
					allow = Promise.withResolvers<void>(),
					answered = Promise.withResolvers<void>();
				yield* Effect.addFinalizer(() => Effect.sync(() => allow.resolve()));
				const f = yield* fixture(
					[
						(call) => {
							if (call.url !== 'https://oauth2.googleapis.com/token') return undefined;
							entered.resolve();
							return allow.promise.then(() => {
								answered.resolve();
								return json({ access_token: 'at-1', refresh_token: 'rt-1' });
							});
						},
						google(() => json({}))
					],
					{}
				);
				yield* f.link.pair!({});
				const state = authorize(f.h).searchParams.get('state')!;
				const callback = () => f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
				const signingIn = yield* Effect.forkChild(Effect.exit(callback()));
				yield* Effect.promise(() => entered.promise);
				const disconnecting = yield* Effect.forkChild(f.link.unpair!());
				yield* Fiber.join(disconnecting);
				expect(Exit.isFailure(yield* Fiber.join(signingIn))).toBe(true);
				expect(f.h.values.has('token')).toBe(false);
				expect((yield* callback()).status).toBe(400);
				expect(yield* Effect.flip(f.link.discover!())).toMatchObject({ _tag: 'OAuthRefused' });
				allow.resolve();
				yield* Effect.promise(() => answered.promise);
				expect(f.h.values.has('token')).toBe(false);
				expect(f.fetch.calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect(
		'disconnect waits for an irreversible calendar credential write before wiping its keys',
		() =>
			Effect.gen(function* () {
				const entered = Promise.withResolvers<void>(),
					allow = Promise.withResolvers<void>();
				yield* Effect.addFinalizer(() => Effect.sync(() => allow.resolve()));
				const f = yield* fixture(
					[google(() => json({ access_token: 'at-1', refresh_token: 'rt-1' }))],
					{},
					HOOK,
					async (changes) => {
						if (!changes.has('token')) return;
						entered.resolve();
						await allow.promise;
					}
				);
				yield* f.link.pair!({});
				const state = authorize(f.h).searchParams.get('state')!;
				const callback = () => f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
				const signingIn = yield* Effect.forkChild(callback());
				yield* Effect.promise(() => entered.promise);
				let disconnected = false;
				const wiped: string[] = [];
				const disconnecting = yield* Effect.forkChild(
					f.link.unpair!().pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								// The host wipes the keys known after the provider's unpair completes.
								wiped.push(...f.h.values.keys());
								f.h.values.clear();
								disconnected = true;
							})
						)
					),
					{ startImmediately: true }
				);
				yield* Effect.yieldNow;
				expect(disconnected).toBe(false);
				allow.resolve();
				yield* Fiber.join(disconnecting);
				expect(Exit.isFailure(yield* Fiber.await(signingIn))).toBe(true);
				yield* until(() => f.h.writes.some((changes) => changes.has('token')));
				expect(wiped).toEqual(expect.arrayContaining(['token', 'state']));
				expect([...f.h.values]).toEqual([]);
				const statuses = f.h.statuses.length,
					events = f.h.events.length;
				expect((yield* callback()).status).toBe(400);
				expect(f.h.statuses).toHaveLength(statuses);
				expect(f.h.events).toHaveLength(events);
				expect(yield* Effect.flip(f.link.discover!())).toMatchObject({ _tag: 'OAuthRefused' });
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect.each([
		{
			returnTo: '/acme/app/crm/calendar',
			status: 303,
			location: 'https://host.example/acme/app/crm/calendar'
		},
		{ returnTo: 'https://other.example/calendar', status: 200, location: null },
		{ returnTo: '//other.example/calendar', status: 200, location: null }
	])(
		'returns a completed sign-in only to the account host: $returnTo',
		({ returnTo, status, location }) =>
			Effect.gen(function* () {
				const f = yield* fixture(
					[google(() => json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 }))],
					{}
				);
				yield* f.link.pair!({ returnTo });
				const state = authorize(f.h).searchParams.get('state')!;
				const response = yield* f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
				expect(response.status).toBe(status);
				expect(response.headers.get('location')).toBe(location);
				const again = yield* f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
				expect(again.status).toBe(status);
				expect(again.headers.get('location')).toBe(location);
				expect(f.h.status?.state).toBe('connected');
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect(
		'refreshes an expired token on use and seals the rotation; a revoked grant asks for a new sign-in',
		() =>
			Effect.gen(function* () {
				let revoked = false;
				const f = yield* fixture(
					[
						google(() =>
							revoked
								? json({ error: 'invalid_grant' }, 400)
								: json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 })
						)
					],
					{ token: { ...TOKEN, exp: NOW - 1 } }
				);
				yield* f.link.discover!();
				expect(f.h.values.get('token')).toMatchObject({ access: 'at-2', refresh: 'rt-2' });
				expect(f.fetch.calls.at(-1)!.headers['authorization']).toBe('Bearer at-2');
				yield* f.now(NOW + 7_200_000);
				revoked = true;
				expect(yield* Effect.flip(f.link.discover!())).toMatchObject({
					_tag: 'OAuthRefused',
					revoked: true
				});
				expect(f.h.status).toMatchObject({
					state: 'error',
					code: 'loggedOut',
					error: expect.stringContaining('Sign in again')
				});
				yield* f.link.close ?? Effect.void;
			})
	);
});

// Two-way sync: the driver's `call` writes one calendar's events through the standing link; a read-only sign-in keeps
// importing, says to reconnect, and never widens its scope on refresh.
describe('the Google Calendar call', () => {
	const EVENTS = '/calendars/visits%40example.com/events';
	const store = () => {
		const events = new Map<string, { [k: string]: Json }>();
		let version = 0;
		const route: Route = (call) => {
			const url = new URL(call.url);
			const path = url.pathname.replace('/calendar/v3', '');
			if (!path.startsWith(EVENTS)) return undefined;
			const id = decodeURIComponent(path.slice(EVENTS.length + 1));
			const current = events.get(id);
			const body: { [k: string]: Json } =
				call.body === ''
					? {}
					: Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject))(call.body);
			const match = call.headers['if-match'];
			if (call.method === 'POST') {
				const key = typeof body['id'] === 'string' ? body['id'] : `generated-${events.size}`;
				if (events.has(key)) return json({ error: { code: 409 } }, 409);
				const made = { ...body, id: key, etag: `"v${++version}"`, status: 'confirmed' };
				events.set(key, made);
				return json(made);
			}
			if (current === undefined) return json({ error: { code: 404 } }, 404);
			if (match !== undefined && match !== current['etag'])
				return json({ error: { code: 412 } }, 412);
			if (call.method === 'GET') return json(current);
			if (call.method === 'DELETE') {
				events.set(id, { ...current, status: 'cancelled', etag: `"v${++version}"` });
				return new Response(null, { status: 204 });
			}
			const patched = { ...current, ...body, etag: `"v${++version}"` };
			events.set(id, patched);
			return json(patched);
		};
		return { events, route };
	};

	it.effect(
		'inserts, patches with If-Match and deletes; never emails guests unless asked; a stale etag is a 412',
		() =>
			Effect.gen(function* () {
				const google = store();
				const f = yield* fixture([google.route]);
				const insert = yield* f.link.request!({
					method: 'POST',
					path: EVENTS,
					query: { sendUpdates: 'none' },
					body: { id: 'hq1', summary: 'Kick-off' }
				});
				expect(insert).toMatchObject({ status: 200, body: { id: 'hq1', etag: '"v1"' } });
				expect(new URL(f.fetch.calls[0]!.url).searchParams.get('sendUpdates')).toBe('none');
				expect(
					yield* f.link.request!({
						method: 'POST',
						path: EVENTS,
						body: { id: 'hq1', summary: 'Kick-off' }
					})
				).toMatchObject({ status: 409 });
				const patched = yield* f.link.request!({
					method: 'PATCH',
					path: `${EVENTS}/hq1`,
					headers: { 'if-match': '"v1"' },
					body: { summary: 'Kick-off (moved)' }
				});
				expect(patched).toMatchObject({
					status: 200,
					body: { summary: 'Kick-off (moved)', etag: '"v2"' }
				});
				expect(f.fetch.calls.at(-1)?.headers['if-match']).toBe('"v1"');
				expect(
					yield* f.link.request!({
						method: 'PATCH',
						path: `${EVENTS}/hq1`,
						headers: { 'if-match': '"v1"' },
						body: { summary: 'clobber' }
					})
				).toMatchObject({ status: 412, body: { error: { code: 412 } } });
				expect(
					yield* f.link.request!({
						method: 'DELETE',
						path: `${EVENTS}/hq1`,
						headers: { 'if-match': '"v2"' }
					})
				).toEqual({ status: 204, body: null });
				expect(google.events.get('hq1')).toMatchObject({ status: 'cancelled' });
				expect(
					f.fetch.calls.every((call) => new URL(call.url).origin === 'https://www.googleapis.com')
				).toBe(true);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect.each([
		{ method: 'GET', path: '/users/me/calendarList' },
		{ method: 'POST', path: '/calendars/primary/events/../../channels/stop' },
		{ method: 'PATCH', path: `${EVENTS}/hq1`, headers: { authorization: 'Bearer stolen' } },
		{ method: 'PUT', path: `${EVENTS}/hq1` }
	])('refuses a call outside one calendar’s events: $method $path', (op) =>
		Effect.gen(function* () {
			const f = yield* fixture([]);
			expect(yield* f.link.request!(op)).toMatchObject({ status: 400 });
			expect(f.fetch.calls).toEqual([]);
			yield* f.link.close ?? Effect.void;
		})
	);
	it.effect(
		'a sign-in sealed read-only keeps importing, asks to reconnect, refuses writes and refreshes without widening',
		() =>
			Effect.gen(function* () {
				const refreshes: URLSearchParams[] = [];
				const legacy = { access: 'old-access', refresh: 'old-refresh', exp: NOW - 1 };
				const f = yield* fixture(
					[
						(call) => {
							if (call.url !== 'https://oauth2.googleapis.com/token') return undefined;
							refreshes.push(new URLSearchParams(call.body));
							return json({ access_token: 'at-2', expires_in: 3600, scope: READ });
						},
						(call) =>
							call.url.includes('/events?') ? json({ items: [], nextSyncToken: 's1' }) : undefined
					],
					{ token: legacy }
				);
				expect(f.h.status).toMatchObject({
					state: 'connected',
					detail: expect.stringContaining('Reconnect')
				});
				expect(yield* read(f, null)).toMatchObject({ cursor: { sync: 's1' } });
				expect(refreshes.map((body) => body.get('scope'))).toEqual([READ]);
				expect(f.h.values.get('token')).toMatchObject({ access: 'at-2', scope: READ });
				expect(
					yield* f.link.request!({ method: 'POST', path: EVENTS, body: { summary: 'x' } })
				).toMatchObject({ status: 403, body: expect.stringContaining('Reconnect') });
				expect(
					f.fetch.calls.some((call) => call.method === 'POST' && call.url.includes('/events'))
				).toBe(false);
				yield* f.link.close ?? Effect.void;
			})
	);
	it.effect('a new sign-in asks to write and reports no reconnect once Google grants it', () =>
		Effect.gen(function* () {
			const f = yield* fixture(
				[
					(call) =>
						call.url === 'https://oauth2.googleapis.com/token'
							? json({
									access_token: 'at-1',
									refresh_token: 'rt-1',
									expires_in: 3600,
									scope: `${READ} ${WRITE}`
								})
							: call.url.includes('/calendarList')
								? json({ items: [{ id: 'ana@example.com', summary: 'Ana', primary: true }] })
								: undefined
				],
				{}
			);
			yield* f.link.pair!({});
			const state = new URL(f.h.pairing!.value!).searchParams.get('state')!;
			yield* f.link.webhook!(new Request(`${REDIRECT}?state=${state}&code=c1`));
			expect(f.h.status).toEqual({ state: 'connected', account: 'ana@example.com' });
			expect(f.h.values.get('token')).toMatchObject({ scope: `${READ} ${WRITE}` });
			yield* f.link.close ?? Effect.void;
		})
	);
});
