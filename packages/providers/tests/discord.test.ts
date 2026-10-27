import { Effect, Schema } from 'effect';
import { TestClock } from 'effect/testing';
// Discord: setup validation with /users/@me, the Gateway handshake over a fake socket (HELLO → IDENTIFY with the
// message-content intent, READY, heartbeats), MESSAGE_CREATE decode, terminal close codes, and the REST send shape.
import { describe, expect, it } from '@effect/vitest';
import { discord, type GatewaySocket } from '../src/discord/index.ts';
import { ProviderUnavailable } from '../src/errors.ts';
import { fakeFetch, file, host, json, messagesOf } from './kit.ts';

const settle = (ok: () => boolean) =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 1000 && !ok(); attempt++) yield* Effect.yieldNow;
		expect(ok()).toBe(true);
	});

type Fake = GatewaySocket & {
	sent: unknown[];
	fire(type: 'message' | 'close', e: { data?: unknown; code?: number }): void;
};
const gateway = () => {
	const sockets: Fake[] = [];
	const socket = () => {
		const listeners: { [t: string]: ((e: { data?: unknown; code?: number }) => void)[] } = {};
		const s: Fake = {
			sent: [],
			send(d) {
				s.sent.push(JSON.parse(d));
			},
			close() {},
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
		(c) => (c.url.endsWith('/messages') ? json({ id: 'm-out' }) : undefined),
		(c) => (c.url.endsWith('/typing') ? new Response(null, { status: 204 }) : undefined)
	]);
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
			expect((yield* Effect.flip(h.link.pair!({}))).message).toMatch(/bot token is required/);
			expect((yield* Effect.flip(h.link.pair!({ botToken: 'bad' }))).message).toMatch(/401/);
			expect(g.sockets).toHaveLength(0);
			yield* h.link.pair!({ botToken: 'good' });
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
				const s = g.sockets[0]!;
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
			g.sockets[0]!.fire('close', { code: 1006 });
			yield* settle(() => h.status?.state === 'reconnecting');
			expect(h.status?.state).toBe('reconnecting');
			yield* TestClock.adjust('999 millis');
			expect(g.sockets).toHaveLength(1);
			yield* TestClock.adjust('1 milli');
			yield* settle(() => g.sockets.length === 2);
			expect(g.sockets).toHaveLength(2);
			g.sockets[1]!.fire('close', { code: 4014 });
			yield* settle(() => h.status?.state === 'error');
			expect(h.status).toMatchObject({
				state: 'error',
				error: expect.stringContaining('Message Content Intent')
			});
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
			expect(yield* h.link.send!({ to: '55', text: 'on it' }, undefined)).toEqual({
				providerId: 'm-out'
			});
			yield* h.link.typing!('55', true);
			yield* h.link.typing!('55', false); // nothing to stop: it lapses by itself
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
	it.effect('attachments go in the same message as multipart files, named', () =>
		Effect.gen(function* () {
			const g = gateway(),
				f = api(),
				h = yield* host(discord({ socket: g.socket }), f, {
					credential: { botToken: 'good', botId: '100', botName: 'crewbot' }
				});
			yield* h.link.send!({ to: '55', text: 'the report' }, [
				file('report.pdf', 'application/pdf', '%PDF r')
			]);
			const form = f.calls[0]!.form!;
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
			expect(f.calls[0]!.headers['content-type']).toMatch(
				/^multipart\/form-data; boundary=[\w-]+$/
			);
			yield* h.link.close ?? Effect.void;
		})
	);
});
