// Webex: signed webhooks that name a message, read back from its API, faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { webex } from '../../src/chat/webex/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { botToken: 'token', webhookSecret: 'secret' };
const message = {
	id: 'M1',
	roomId: 'R1',
	roomType: 'group',
	parentId: 'P1',
	personId: 'U1',
	personEmail: 'ann@acme.test',
	personDisplayName: 'Ann',
	text: 'hello',
	created: '2026-11-05T10:00:00.000Z',
	mentionedPeople: ['BOT'],
	files: ['https://webexapis.com/v1/contents/F1']
};
const answer = ({ url, body }: Call) => {
	if (url.endsWith('/people/me')) return json({ id: 'BOT', nickName: 'Acme' });
	if (url.endsWith('/messages/M1')) return json(message);
	if (url.endsWith('/messages/OWN')) return json({ ...message, id: 'OWN', personId: 'BOT' });
	if (url.endsWith('/messages/GONE')) return json({ message: 'not found' }, 404);
	if (url.endsWith('/contents/F1')) return new Response(new Uint8Array([1, 2, 3]));
	if (url.endsWith('/messages') && body !== '') return json({ id: 'out1' });
	return json({});
};
const event = (id: string, extra: object = {}) =>
	JSON.stringify({ resource: 'messages', event: 'created', data: { id }, ...extra });
const signature = (body: string) => ({
	'x-spark-signature': createHmac('sha1', 'secret').update(body).digest('hex')
});
const hostFor = (fetch: typeof globalThis.fetch) => ({
	fetch,
	webhookUrl: 'https://hook.test/',
	receive: () => Promise.resolve()
});

describe('Webex', () => {
	it.live('reads a signed event back and stores it before acknowledging', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(webex, settings),
				body = event('M1');
			expect(h.status).toMatchObject({ state: 'connected', account: 'Acme' });
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				bins: [new Uint8Array([1, 2, 3])],
				messages: [
					{
						id: 'M1',
						thread: 'R1:P1',
						sentAt: '2026-11-05T10:00:00.000Z',
						from: { handle: 'U1', name: 'Ann' },
						text: 'hello',
						group: true,
						replyTo: 'P1',
						invocation: 'mention',
						attachments: [{ name: 'F1', bin: 0 }]
					}
				]
			});
			expect(api.calls.at(-1)?.headers.get('authorization')).toBe('Bearer token');
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(webex, settings),
				body = event('M1'),
				before = api.calls.length;
			const refused = yield* h.link.webhook!(webhook(body, { 'x-spark-signature': 'forged' }));
			expect(refused.status).toBe(401);
			expect(h.events).toEqual([]);
			expect(api.calls.length).toBe(before);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(webex, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = event('M1');
			expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(500);
		})
	);
	it.live('skips its own message, one already gone, and other events', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(webex, settings);
			for (const body of [
				event('OWN'),
				event('GONE'),
				JSON.stringify({ resource: 'memberships', event: 'created', data: { id: 'M1' } })
			])
				expect((yield* h.link.webhook!(webhook(body, signature(body)))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('sends markdown into a room and its thread', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(webex, settings);
			const sent = yield* h.link.send!({ id: 'r1', to: 'R1:P1', text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			expect(api.calls.at(-1)?.url).toBe('https://webexapis.com/v1/messages');
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toEqual({
				roomId: 'R1',
				parentId: 'P1',
				markdown: 'Hello'
			});
		})
	);
	it.live('a token Webex refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'unauthorized' }, 401));
			const h = yield* host(chatProvider(webex), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it('history stops at the window, and reads a group for its mentions', async () => {
		const calls: string[] = [];
		const items = [
			{ ...message, id: 'NEW', parentId: undefined },
			{ ...message, id: 'MINE', parentId: undefined, personId: 'BOT' },
			{ ...message, id: 'REPLY' },
			{ ...message, id: 'OLD', parentId: undefined, created: '2026-11-01T00:00:00.000Z' }
		];
		const connection = await webex.connect(
			settings,
			hostFor(async (input) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith('/people/me')) return json({ id: 'BOT' });
				if (url.includes('/rooms/')) return json({ type: 'group' });
				return json({ items });
			})
		);
		const read = await connection.history!('R1', '2026-11-05T00:00:00.000Z');
		expect(read.complete).toBe(true);
		expect(read.messages.map((one) => one.id)).toEqual(['NEW']);
		const query = new URL(calls.at(-1) ?? '').searchParams;
		expect(query.get('roomId')).toBe('R1');
		expect(query.get('mentionedPeople')).toBe('me');
	});
	it('history that runs out of pages says it is incomplete', async () => {
		const items = Array.from({ length: 100 }, (_, n) => ({ ...message, id: `M${n}` }));
		const calls: string[] = [];
		const connection = await webex.connect(
			settings,
			hostFor(async (input) => {
				const url = String(input);
				calls.push(url);
				if (url.endsWith('/people/me')) return json({ id: 'BOT' });
				if (url.includes('/rooms/')) return json({ type: 'direct' });
				return json({ items });
			})
		);
		const read = await connection.history!('R1:P1', '2026-11-05T00:00:00.000Z');
		expect(read.complete).toBe(false);
		expect(new URL(calls.at(-1) ?? '').searchParams.get('beforeMessage')).toBe('M99');
		expect(new URL(calls.at(-1) ?? '').searchParams.get('mentionedPeople')).toBeNull();
	});
});
