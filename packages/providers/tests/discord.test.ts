import { Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
// Discord: setup validation with /users/@me, the Gateway handshake over a fake socket (HELLO → IDENTIFY with the
// message-content intent, READY, heartbeats), RESUME and its fallback, the sequence a refused store holds back, message
// events, reconcile, terminal close codes, every heartbeat and socket ending, and the REST send shape.
import { describe, expect, it } from '@effect/vitest';
import { discord, type GatewaySocket } from '../src/discord/index.ts';
import { ProviderUnavailable } from '../src/errors.ts';
import { type DriverEvent, Fenced } from '@norbital-ai/host-api';
import { required, fakeFetch, file, host, json, messagesOf, until } from './kit.ts';

const settle = (ok: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 1000 && !ok(); attempt++) yield* Effect.yieldNow;
		expect(ok()).toBe(true);
	});

type Fake = GatewaySocket & {
	url: string;
	sent: unknown[];
	closes: (number | undefined)[];
	fire(type: 'message' | 'close', e: { data?: unknown; code?: number }): void;
};
const gateway = () => {
	const sockets: Fake[] = [];
	const socket = (url: string) => {
		const listeners: { [t: string]: ((e: { data?: unknown; code?: number }) => void)[] } = {};
		const s: Fake = {
			url,
			sent: [],
			closes: [],
			send(d) {
				s.sent.push(JSON.parse(d));
			},
			close(code) {
				s.closes.push(code);
			},
			addEventListener(t, l) {
				(listeners[t] ??= []).push(l);
			},
			fire(t, e) {
				for (const l of listeners[t] ?? []) l(e);
			}
		};
		sockets.push(s);
		return s;
	};
	return { sockets, socket };
};
const api = () =>
	fakeFetch([
		(c) =>
			c.url.endsWith('/users/@me')
				? c.headers['authorization'] === 'Bot good'
					? json({ id: '100', username: 'crewbot' })
					: json({ message: '401: Unauthorized' }, 401)
				: undefined,
		(c) => (c.url.endsWith('/users/@me/channels') ? json({ id: '77', type: 1 }) : undefined),
		(c) => (c.url.endsWith('/messages') ? json({ id: 'm-out' }) : undefined),
		(c) => (c.url.endsWith('/typing') ? new Response(null, { status: 204 }) : undefined)
	]);
const CREDENTIAL = { credential: { botToken: 'good', botId: '100', botName: 'crewbot' } };
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json';
const RESUME = 'wss://resume.discord.gg?v=10&encoding=json';
const frame = (s: Fake, value: object) => s.fire('message', { data: JSON.stringify(value) });
const hello = (s: Fake, interval = 60_000) =>
	frame(s, { op: 10, d: { heartbeat_interval: interval } });
const ready = (s: Fake) =>
	frame(s, {
		op: 0,
		t: 'READY',
		s: 1,
		d: { guilds: [], session_id: 's-1', resume_gateway_url: 'wss://resume.discord.gg' }
	});
const sentOp = (s: Fake, op: number) =>
	s.sent.filter(
		(value) => typeof value === 'object' && value !== null && 'op' in value && value.op === op
	);
/** A link whose gateway reached READY on socket 0. */
const connected = (g: ReturnType<typeof gateway>, emit?: (e: DriverEvent) => Promise<void>) =>
	Effect.gen(function* () {
		const h = yield* host(
			discord({ socket: g.socket }),
			api(),
			CREDENTIAL,
			emit === undefined ? {} : { emit }
		);
		yield* settle(() => g.sockets.length === 1);
		const s = required(g.sockets[0]);
		hello(s);
		yield* settle(() => sentOp(s, 2).length === 1);
		ready(s);
		yield* settle(() => h.status?.state === 'connected');
		return { h, s };
	});
/** The next socket once the backoff passes, greeted. */
const reopened = (g: ReturnType<typeof gateway>, count: number) =>
	Effect.gen(function* () {
		yield* TestClock.adjust('60 seconds');
		yield* settle(() => g.sockets.length === count);
		const s = required(g.sockets[count - 1]);
		hello(s);
		return s;
	});
const msg = (d: object) => ({
	op: 0,
	t: 'MESSAGE_CREATE',
	s: 3,
	d: {
		id: 'm1',
		channel_id: '55',
		guild_id: 'g1',
		timestamp: '2026-10-01T10:00:00.000Z',
		content: 'hi',
		author: { id: '7', username: 'ana', global_name: 'Ana' },
		mentions: [],
		...d
	}
});

describe('Discord', () => {
	it.effect('validates the token with /users/@me before opening a gateway', () =>
		Effect.gen(function* () {
			const g = gateway(),
				f = api(),
				h = yield* host(discord({ socket: g.socket }), f);
			expect((yield* Effect.flip(required(h.link.pair)({}))).message).toMatch(/bot token is required/);
			expect((yield* Effect.flip(required(h.link.pair)({ botToken: 'bad' }))).message).toMatch(/401/);
			expect(g.sockets).toHaveLength(0);
			yield* required(h.link.pair)({ botToken: 'good' });
			expect(Object.fromEntries(h.values)).toEqual({
				credential: { botToken: 'good', botId: '100', botName: 'crewbot' }
			});
			expect(h.status).toMatchObject({
				state: 'connecting',
				about: { inviteUrl: expect.stringContaining('client_id=100') }
			});
		})
	);
	it.effect(
		'identifies with the message-content intent, is connected on READY and decodes messages',
		() =>
			Effect.gen(function* () {
				const g = gateway(),
					h = yield* host(discord({ socket: g.socket }), api(), {
						credential: { botToken: 'good', botId: '100', botName: 'crewbot' }
					});
				yield* settle(() => g.sockets.length === 1);
				const s = required(g.sockets[0]);
				s.fire('message', { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
				yield* settle(() =>
					s.sent.some(
						(value) =>
							typeof value === 'object' && value !== null && 'op' in value && value.op === 2
					)
				);
				expect(
					s.sent.find(
						(value) =>
							typeof value === 'object' && value !== null && 'op' in value && value.op === 2
					)
				).toMatchObject({ op: 2, d: { token: 'good' } });
				const identified = Schema.decodeUnknownSync(
					Schema.Struct({ op: Schema.Literal(2), d: Schema.Struct({ intents: Schema.Number }) })
				)(
					s.sent.find(
						(value) =>
							typeof value === 'object' && value !== null && 'op' in value && value.op === 2
					)
				);
				expect((identified.d.intents & (1 << 15)) !== 0).toBe(true);
				s.fire('message', {
					data: JSON.stringify({
						op: 0,
						t: 'READY',
						s: 1,
						d: { guilds: [{ id: 'g1' }, { id: 'g2' }] }
					})
				});
				yield* settle(() => h.status?.state === 'connected');
				expect(h.status).toMatchObject({
					state: 'connected',
					account: 'crewbot',
					about: { guilds: 2 }
				});
				s.fire('message', {
					data: JSON.stringify(msg({ mentions: [{ id: '100' }], content: '<@100> status' }))
				});
				s.fire('message', {
					data: JSON.stringify(msg({ id: 'm2', guild_id: undefined, channel_id: '66' }))
				});
				s.fire('message', {
					data: JSON.stringify(msg({ id: 'm3', author: { id: '100', bot: true } }))
				});
				yield* settle(() => messagesOf(h.events).length === 2);
				expect(messagesOf(h.events)).toMatchObject([
					{
						id: 'm1',
						thread: '55',
						group: true,
						invocation: 'mention',
						from: { handle: '7', name: 'Ana' }
					},
					{ id: 'm2', thread: '66', group: false, invocation: 'direct' }
				]);
				s.fire('message', { data: JSON.stringify({ op: 1 }) });
				yield* settle(() => JSON.stringify(s.sent.at(-1)) === JSON.stringify({ op: 1, d: 3 }));
				expect(s.sent.at(-1)).toEqual({ op: 1, d: 3 });
				yield* h.link.close ?? Effect.void;
			})
	);
	it.effect('a refused token or a missing intent is terminal; any other close reconnects', () =>
		Effect.gen(function* () {
			const g = gateway(),
				h = yield* host(discord({ socket: g.socket }), api(), {
					credential: { botToken: 'good', botId: '100', botName: 'crewbot' }
				});
			yield* settle(() => g.sockets.length === 1);
			required(g.sockets[0]).fire('close', { code: 1006 });
			yield* settle(() => h.status?.state === 'reconnecting');
			expect(h.status?.state).toBe('reconnecting');
			yield* TestClock.adjust('999 millis');
			expect(g.sockets).toHaveLength(1);
			yield* TestClock.adjust('1 milli');
			yield* settle(() => g.sockets.length === 2);
			expect(g.sockets).toHaveLength(2);
			required(g.sockets[1]).fire('close', { code: 4014 });
			yield* settle(() => h.status?.state === 'error');
			expect(h.status).toMatchObject({
				state: 'error',
				error: expect.stringContaining('Message Content Intent')
			});
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect(
		'resumes the session on its resume URL from the last sequence, without identifying',
		() =>
			Effect.gen(function* () {
				const g = gateway(),
					{ h, s } = yield* connected(g);
				frame(s, { ...msg({}), s: 2 });
				yield* settle(() => messagesOf(h.events).length === 1);
				s.fire('close', { code: 1006 });
				yield* settle(() => h.status?.state === 'reconnecting');
				const next = yield* reopened(g, 2);
				expect(next.url).toBe(RESUME);
				yield* settle(() => sentOp(next, 6).length === 1);
				expect(sentOp(next, 6)).toEqual([
					{ op: 6, d: { token: 'good', session_id: 's-1', seq: 2 } }
				]);
				expect(sentOp(next, 2)).toEqual([]);
				frame(next, { op: 0, t: 'RESUMED', s: 4, d: {} });
				yield* settle(() => h.status?.state === 'connected');
				yield* h.link.close ?? Effect.void;
			})
	);
	it.effect('an invalid session that may resume resumes; one that may not identifies afresh', () =>
		Effect.gen(function* () {
			const g = gateway(),
				{ s } = yield* connected(g);
			frame(s, { op: 9, d: true });
			yield* settle(() => s.closes.length > 0);
			expect(s.closes[0]).toBe(4000);
			s.fire('close', { code: 4000 });
			const resumed = yield* reopened(g, 2);
			expect(resumed.url).toBe(RESUME);
			yield* settle(() => sentOp(resumed, 6).length === 1);
			frame(resumed, { op: 9, d: false });
			yield* settle(() => resumed.closes.length > 0);
			resumed.fire('close', { code: 4000 });
			const fresh = yield* reopened(g, 3);
			expect(fresh.url).toBe(GATEWAY);
			yield* settle(() => sentOp(fresh, 2).length === 1);
			expect(sentOp(fresh, 6)).toEqual([]);
			// the old session's sequence is not this one's
			frame(fresh, { op: 1 });
			yield* settle(() => sentOp(fresh, 1).length >= 2);
			expect(sentOp(fresh, 1).at(-1)).toEqual({ op: 1, d: null });
		})
	);
	it.effect('a session timed out, a refused seq and a dead resume URL each identify afresh', () =>
		Effect.gen(function* () {
			for (const code of [4007, 4009]) {
				const g = gateway(),
					{ s } = yield* connected(g);
				s.fire('close', { code });
				const next = yield* reopened(g, 2);
				expect(next.url).toBe(GATEWAY);
				yield* settle(() => sentOp(next, 2).length === 1);
			}
			const g = gateway(),
				{ s } = yield* connected(g);
			s.fire('close', { code: 1006 });
			yield* TestClock.adjust('60 seconds');
			yield* settle(() => g.sockets.length === 2);
			expect(required(g.sockets[1]).url).toBe(RESUME);
			required(g.sockets[1]).fire('close', { code: 1006 });
			const next = yield* reopened(g, 3);
			expect(next.url).toBe(GATEWAY);
			yield* settle(() => sentOp(next, 2).length === 1);
		})
	);
	it.effect('a refused store keeps the sequence and the session, so the resume replays it', () =>
		Effect.gen(function* () {
			let refusing = false;
			const g = gateway(),
				{ h, s } = yield* connected(g, (e) =>
					refusing && JSON.stringify(messagesOf([e])).includes('"id":"m2"')
						? Promise.reject(new Error('the store is down'))
						: Promise.resolve()
				);
			frame(s, { ...msg({}), s: 2 });
			yield* settle(() => messagesOf(h.events).length === 1);
			refusing = true;
			// in one tick, so `m3` sits queued behind the refused `m2`
			frame(s, { ...msg({ id: 'm2' }), s: 3 });
			frame(s, { ...msg({ id: 'm3' }), s: 4 });
			yield* settle(() => s.closes.length > 0);
			// 1000 would end the session the resume needs
			expect(s.closes).toEqual([4000]);
			expect(messagesOf(h.events)).toMatchObject([{ id: 'm1' }]);
			expect(messagesOf(h.events)).toHaveLength(1);
			refusing = false;
			const next = yield* reopened(g, 2);
			yield* settle(() => sentOp(next, 6).length === 1);
			expect(sentOp(next, 6)).toEqual([{ op: 6, d: { token: 'good', session_id: 's-1', seq: 2 } }]);
			frame(next, { ...msg({ id: 'm2' }), s: 3 });
			frame(next, { ...msg({ id: 'm3' }), s: 4 });
			frame(next, { op: 0, t: 'RESUMED', s: 5, d: {} });
			yield* settle(() => h.status?.state === 'connected');
			expect(messagesOf(h.events)).toMatchObject([{ id: 'm1' }, { id: 'm2' }, { id: 'm3' }]);
			frame(next, { op: 1 });
			yield* settle(() => sentOp(next, 1).length >= 2);
			expect(sentOp(next, 1).at(-1)).toEqual({ op: 1, d: 5 });
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('a fenced store stops the link instead of reconnecting', () =>
		Effect.gen(function* () {
			const g = gateway(),
				{ s } = yield* connected(g, () =>
					Promise.reject(new Fenced({ instance: 'desk', message: 'replaced' }))
				);
			frame(s, { ...msg({}), s: 2 });
			yield* settle(() => s.closes.length > 0);
			yield* TestClock.adjust('10 minutes');
			yield* Effect.yieldNow;
			expect(g.sockets).toHaveLength(1);
		})
	);
	it.effect(
		'an edit converges by its timestamp, and deletes tombstone; an unfurl changes nothing',
		() =>
			Effect.gen(function* () {
				const g = gateway(),
					{ h, s } = yield* connected(g);
				frame(s, {
					...msg({ edited_timestamp: '2026-10-01T10:05:00.000Z', content: 'fixed' }),
					t: 'MESSAGE_UPDATE'
				});
				frame(s, { ...msg({ id: 'm2', edited_timestamp: null }), t: 'MESSAGE_UPDATE' });
				frame(s, {
					op: 0,
					t: 'MESSAGE_UPDATE',
					s: 4,
					d: { id: 'm3', channel_id: '55', embeds: [] }
				});
				frame(s, { op: 0, t: 'MESSAGE_DELETE', s: 5, d: { id: 'm4', channel_id: '55' } });
				frame(s, {
					op: 0,
					t: 'MESSAGE_DELETE_BULK',
					s: 6,
					d: { ids: ['m5', 'm6'], channel_id: '55', guild_id: 'g1' }
				});
				yield* settle(() => messagesOf(h.events).length === 4);
				expect(messagesOf(h.events)).toMatchObject([
					{
						id: 'm1',
						text: 'fixed',
						version: '2026-10-01T10:05:00.000Z',
						sent_at: '2026-10-01T10:00:00.000Z'
					},
					{ id: 'm4', deleted: true },
					{ id: 'm5', deleted: true },
					{ id: 'm6', deleted: true }
				]);
				yield* h.link.close ?? Effect.void;
			})
	);
	it.effect('reconciles a channel by key from `since`, oldest first, with no bytes', () =>
		Effect.gen(function* () {
			const since = '2026-10-01T00:00:00.000Z',
				first = ((BigInt(Date.parse(since)) - 1420070400000n) << 22n) - 1n;
			// newest first and naming no guild, as REST answers
			const full = Array.from({ length: 100 }, (_, i) => ({
				...msg({ id: String(1100 - i), guild_id: undefined, timestamp: since }).d
			}));
			const f = fakeFetch([
				(c) =>
					c.url.endsWith('/channels/55') ? json({ id: '55', guild_id: 'g1', type: 0 }) : undefined,
				(c) => {
					const after = new URL(c.url).searchParams.get('after');
					return after === String(first)
						? json(full)
						: after === '1100'
							? json([
									msg({
										id: '1102',
										guild_id: undefined,
										edited_timestamp: '2026-10-02T00:00:00.000Z',
										attachments: [
											{
												id: 'a',
												filename: 'r.pdf',
												size: 9,
												url: 'https://cdn.discordapp.com/r.pdf'
											}
										]
									}).d,
									msg({ id: '1101', guild_id: undefined, author: { id: '100', bot: true } }).d
								])
							: after === '1102'
								? json([])
								: undefined;
				}
			]);
			const g = gateway(),
				h = yield* host(discord({ socket: g.socket }), f, CREDENTIAL);
			const page = yield* required(h.link.reconcile)('55', since);
			expect(page.complete).toBe(true);
			expect(page.bins).toBeUndefined();
			expect(page.messages).toMatchObject([
				...full.map(({ id }) => ({ id })).toReversed(),
				{ id: '1102' }
			]);
			expect(page.messages.at(-1)).toMatchObject({
				thread: '55',
				group: true,
				invocation: 'ambient',
				version: '2026-10-02T00:00:00.000Z',
				attachments: [{ name: 'r.pdf', bytes: 9 }]
			});
			expect(f.calls.some((c) => c.url.includes('cdn.discordapp.com'))).toBe(false);
			expect(f.calls.every((c) => c.headers['authorization'] === 'Bot good')).toBe(true);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('a DM reconciles as direct; only a window read to its end is complete', () =>
		Effect.gen(function* () {
			const since = '2026-10-01T00:00:00.000Z';
			const answering = (messages: (query: URLSearchParams) => unknown) =>
				fakeFetch([
					(c) => (c.url.endsWith('/channels/66') ? json({ id: '66', type: 1 }) : undefined),
					(c) =>
						c.url.includes('/messages?') ? json(messages(new URL(c.url).searchParams)) : undefined
				]);
			const open = (f: ReturnType<typeof fakeFetch>) =>
				host(discord({ socket: gateway().socket }), f, CREDENTIAL);
			const one = answering((query) =>
				query.get('after') === '7'
					? []
					: [msg({ id: '7', channel_id: '66', guild_id: undefined }).d]
			);
			expect(yield* required((yield* open(one)).link.reconcile)('66', since)).toMatchObject({
				complete: true,
				messages: [{ id: '7', group: false, invocation: 'direct' }]
			});
			// without READ_MESSAGE_HISTORY Discord answers an empty list: that proves nothing was deleted
			const blind = yield* required((yield* open(answering(() => []))).link.reconcile)('66', since);
			expect(blind).toEqual({ messages: [], complete: false });
			// a window that never ends within the walk deletes nothing
			let id = 2000;
			const endless = answering(() =>
				Array.from(
					{ length: 100 },
					() => msg({ id: String(id++), channel_id: '66' }).d
				).toReversed()
			);
			const capped = yield* required((yield* open(endless)).link.reconcile)('66', since);
			expect(capped.complete).toBe(false);
			expect(capped.messages).toHaveLength(500);
			// a channel the bot cannot read skips that thread: the engine would end its pass on a refusal
			const refused = fakeFetch([() => json({ message: 'Missing Access', code: 50001 }, 403)]);
			expect(yield* required((yield* open(refused)).link.reconcile)('66', since)).toEqual({
				messages: [],
				complete: false
			});
			const down = fakeFetch([() => json({ message: 'slow down' }, 429)]);
			expect(yield* Effect.flip(required((yield* open(down)).link.reconcile)('66', since))).toMatchObject({
				_tag: 'ProviderUnavailable'
			});
		})
	);
	it.effect('ends every heartbeat and socket on a reconnect and on close', () =>
		Effect.gen(function* () {
			const g = gateway(),
				h = yield* host(discord({ socket: g.socket }), api(), CREDENTIAL),
				beats = (s: Fake) => sentOp(s, 1).length;
			yield* settle(() => g.sockets.length === 1);
			const first = required(g.sockets[0]);
			hello(first, 1000);
			for (let beat = 1; beat <= 4; beat++) {
				yield* settle(() => beats(first) === beat);
				frame(first, { op: 11 });
				yield* Effect.yieldNow;
				yield* TestClock.adjust('1 second');
			}
			yield* settle(() => beats(first) === 5);
			first.fire('close', { code: 1006 });
			yield* settle(() => h.status?.state === 'reconnecting');
			const stopped = beats(first);
			yield* TestClock.adjust('1 second');
			yield* settle(() => g.sockets.length === 2);
			const second = required(g.sockets[1]);
			hello(second, 1000);
			for (let beat = 1; beat <= 5; beat++) {
				yield* settle(() => beats(second) === beat);
				frame(second, { op: 11 });
				yield* Effect.yieldNow;
				yield* TestClock.adjust('1 second');
			}
			yield* settle(() => beats(second) === 6);
			expect(beats(first)).toBe(stopped);
			expect(first.closes).toHaveLength(1);
			yield* h.link.close ?? Effect.void;
			// a link that closes for good ends its session
			expect(second.closes).toEqual([1000]);
			yield* TestClock.adjust('1 hour');
			yield* Effect.yieldNow;
			expect(beats(second)).toBe(6);
			expect(beats(first)).toBe(stopped);
			expect(g.sockets).toHaveLength(2);
		})
	);
	it.effect('a gateway that stops acknowledging heartbeats is dropped and resumed', () =>
		Effect.gen(function* () {
			const g = gateway(),
				h = yield* host(discord({ socket: g.socket }), api(), CREDENTIAL),
				beats = (s: Fake) => sentOp(s, 1).length;
			yield* settle(() => g.sockets.length === 1);
			const s = required(g.sockets[0]);
			hello(s, 1000);
			yield* settle(() => sentOp(s, 2).length === 1);
			ready(s);
			yield* settle(() => h.status?.state === 'connected');
			frame(s, { op: 11 });
			yield* Effect.yieldNow;
			yield* TestClock.adjust('1 second');
			yield* settle(() => beats(s) === 2);
			// the second beat went unanswered: the third finds it
			expect(h.status?.state).toBe('connected');
			expect(s.closes).toEqual([]);
			yield* TestClock.adjust('1 second');
			yield* settle(() => h.status?.state === 'reconnecting');
			// no close event comes from a half-open socket, and 1000 would end the session
			expect(s.closes).toEqual([4000]);
			const stopped = beats(s);
			const next = yield* reopened(g, 2);
			expect(next.url).toBe(RESUME);
			yield* settle(() => sentOp(next, 6).length === 1);
			expect(sentOp(next, 2)).toEqual([]);
			expect(beats(s)).toBe(stopped);
			yield* h.link.close ?? Effect.void;
			expect(next.closes).toEqual([1000]);
			yield* TestClock.adjust('1 hour');
			yield* Effect.yieldNow;
			expect(beats(s)).toBe(stopped);
			expect(g.sockets).toHaveLength(2);
		})
	);
	it.effect('an answered heartbeat keeps the socket, however long a store holds the loop', () =>
		Effect.gen(function* () {
			let release = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const g = gateway(),
				{ h, s } = yield* connected(g, (e) =>
					JSON.stringify(messagesOf([e])).includes('"id":"m2"') ? held : Promise.resolve()
				);
			frame(s, { op: 11 });
			frame(s, { ...msg({ id: 'm2' }), s: 2 });
			yield* Effect.yieldNow;
			// each interval's beat and its ACK queue behind the held store, in order
			for (let beat = 0; beat < 3; beat++) {
				yield* TestClock.adjust('60 seconds');
				frame(s, { op: 11 });
			}
			release();
			yield* until(() => messagesOf(h.events).length === 1);
			yield* Effect.promise(() => held);
			yield* TestClock.adjust('60 seconds');
			yield* Effect.yieldNow;
			expect(s.closes).toEqual([]);
			expect(h.status?.state).toBe('connected');
			expect(g.sockets).toHaveLength(1);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('pairing again starts a new session: the old one was another token', () =>
		Effect.gen(function* () {
			const g = gateway(),
				{ h } = yield* connected(g);
			yield* required(h.link.pair)({ botToken: 'good' });
			yield* settle(() => g.sockets.length === 2);
			const next = required(g.sockets[1]);
			expect(next.url).toBe(GATEWAY);
			hello(next);
			yield* settle(() => sentOp(next, 2).length === 1);
			expect(sentOp(next, 6)).toEqual([]);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('sends and types through REST with the bot token', () =>
		Effect.gen(function* () {
			const g = gateway(),
				f = api(),
				h = yield* host(discord({ socket: g.socket }), f, {
					credential: { botToken: 'good', botId: '100', botName: 'crewbot' }
				});
			expect(yield* required(h.link.send)({ to: '55', text: 'on it' }, undefined)).toEqual({
				provider_id: 'm-out'
			});
			yield* required(h.link.typing)('55', true);
			yield* required(h.link.typing)('55', false); // nothing to stop: it lapses by itself
			expect(f.calls.map((c) => [c.method, c.url, c.headers['authorization'], c.body])).toEqual([
				[
					'POST',
					'https://discord.com/api/v10/channels/55/messages',
					'Bot good',
					'{"content":"on it"}'
				],
				['POST', 'https://discord.com/api/v10/channels/55/typing', 'Bot good', '']
			]);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('sends to `@<user id>` in the DM channel Discord opens with that person', () =>
		Effect.gen(function* () {
			const g = gateway(),
				f = api(),
				h = yield* host(discord({ socket: g.socket }), f, CREDENTIAL);
			expect(yield* required(h.link.send)({ to: '@123456789012345678', text: 'Your report' }, undefined)).toEqual({
				provider_id: 'm-out'
			});
			yield* required(h.link.typing)('@123456789012345678', true); // a person has no channel to type in yet
			expect(f.calls.map((c) => [c.method, c.url, c.body])).toEqual([
				['POST', 'https://discord.com/api/v10/users/@me/channels', '{"recipient_id":"123456789012345678"}'],
				['POST', 'https://discord.com/api/v10/channels/77/messages', '{"content":"Your report"}']
			]);
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('a repeat of a message carries the same enforced nonce, so Discord keeps one', () =>
		Effect.gen(function* () {
			const g = gateway(),
				f = api(),
				h = yield* host(discord({ socket: g.socket }), f, CREDENTIAL),
				id = '0190b4a2-7c1e-7f3a-9d52-3f6c1e2a4b10';
			yield* required(h.link.send)({ id, to: '55', text: 'on it' }, undefined);
			yield* required(h.link.send)({ id, to: '55', text: 'on it' }, undefined);
			yield* required(h.link.send)({ id: 'another', to: '55', text: 'on it' }, undefined);
			yield* required(h.link.send)({ id, to: '55', text: 'with a file' }, [
				file('report.pdf', 'application/pdf', '%PDF r')
			]);
			const [first, again, other] = f.calls
				.slice(0, 3)
				.map((c) =>
					Schema.decodeUnknownSync(
						Schema.fromJsonString(
							Schema.Struct({ nonce: Schema.String, enforce_nonce: Schema.Boolean })
						)
					)(c.body)
				);
			expect(required(first).enforce_nonce).toBe(true);
			expect(required(first).nonce.length).toBeLessThanOrEqual(25);
			expect(required(again).nonce).toBe(required(first).nonce);
			expect(required(other).nonce).not.toBe(required(first).nonce);
			const payload = required(required(f.calls[3]).form).get('payload_json');
			if (typeof payload !== 'string') throw new Error('The multipart JSON payload is missing.');
			expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(payload)).toMatchObject({
				nonce: required(first).nonce,
				enforce_nonce: true
			});
			yield* h.link.close ?? Effect.void;
		})
	);
	it.effect('attachments go in the same message as multipart files, named', () =>
		Effect.gen(function* () {
			const g = gateway(),
				f = api(),
				h = yield* host(discord({ socket: g.socket }), f, {
					credential: { botToken: 'good', botId: '100', botName: 'crewbot' }
				});
			yield* required(h.link.send)({ to: '55', text: 'the report' }, [
				file('report.pdf', 'application/pdf', '%PDF r')
			]);
			const form = required(required(f.calls[0]).form);
			const payload = form.get('payload_json');
			if (typeof payload !== 'string') throw new Error('The multipart JSON payload is missing.');
			expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(payload)).toEqual({
				content: 'the report',
				attachments: [{ id: 0, filename: 'report.pdf' }]
			});
			const part = form.get('files[0]');
			if (!(part instanceof File)) throw new Error('The multipart attachment is missing.');
			expect([
				part.name,
				part.type,
				yield* Effect.tryPromise({
					try: () => part.text(),
					catch: (error) => new ProviderUnavailable({ message: String(error) })
				})
			]).toEqual(['report.pdf', 'application/pdf', '%PDF r']);
			expect(required(f.calls[0]).headers['content-type']).toMatch(
				/^multipart\/form-data; boundary=[\w-]+$/
			);
			yield* h.link.close ?? Effect.void;
		})
	);
});
