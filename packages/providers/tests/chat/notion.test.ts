// Notion: deliveries signed as Notion signs them, and its REST API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { notion } from '../../src/chat/notion/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { token: 'ntn_token', verificationToken: 'secret_token' };
const me = { id: 'bot', name: 'Norbius', bot: { workspace_name: 'Acme' } };
const comment = (extra: object = {}) => ({
	id: 'c1',
	discussion_id: 'd1',
	created_by: { id: 'u1', name: 'Ada' },
	created_time: '2026-11-01T10:00:00.000Z',
	last_edited_time: '2026-11-01T10:00:00.000Z',
	parent: { type: 'page_id', page_id: 'p1' },
	rich_text: [{ type: 'text', plain_text: 'hello' }],
	...extra
});
const answer =
	(found: object | null = comment()) =>
	({ url, body }: Call) => {
		const { pathname } = new URL(url);
		if (pathname === '/v1/users/me') return json(me);
		if (pathname === '/v1/comments')
			return json({ id: `sent:${JSON.parse(body).markdown.length}`, discussion_id: 'd9' });
		if (pathname.startsWith('/v1/comments/'))
			return found === null ? json({ code: 'object_not_found' }, 404) : json(found);
		return new Response(new Uint8Array([1, 2, 3]));
	};
const event = (type: string, extra: object = {}) =>
	JSON.stringify({
		id: 'e1',
		timestamp: '2026-11-01T10:00:01.000Z',
		type,
		entity: { id: 'c1', type: 'comment' },
		data: { page_id: 'p1', parent: { id: 'p1', type: 'page' } },
		...extra
	});
const signature = (body: string, secret = 'secret_token') =>
	`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const delivery = (body: string) => webhook(body, { 'x-notion-signature': signature(body) });

describe('Notion', () => {
	it.live('reads back a signed comment and stores it before acknowledging', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(notion, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'Acme' });
			expect((yield* required(h.link.webhook)(delivery(event('comment.created')))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'c1',
						thread: 'p1',
						sent_at: '2026-11-01T10:00:00.000Z',
						from: { handle: 'u1', name: 'Ada' },
						text: 'hello',
						group: true,
						invocation: 'ambient'
					}
				]
			});
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(notion, settings),
				body = event('comment.created');
			const forged = webhook(body, { 'x-notion-signature': signature(body, 'guess') });
			expect((yield* required(h.link.webhook)(forged)).status).toBe(401);
			expect((yield* required(h.link.webhook)(webhook(body, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a comment the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(notion, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* required(h.link.webhook)(delivery(event('comment.created')))).status).toBe(500);
		})
	);
	it.live('answers the unsigned handshake with a token set or not, storing nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(notion, { token: 'ntn_token' });
			const handshake = webhook('{"verification_token":"secret_abc"}', {});
			expect((yield* required(h.link.webhook)(handshake)).status).toBe(200);
			expect(h.events).toEqual([]);
			expect(h.status).toMatchObject({ about: { verificationToken: 'secret_abc' } });
		})
	);
	it.live(
		'with no token yet, nothing passes, a delivery signed under the empty key least of all',
		() =>
			Effect.gen(function* () {
				yield* platformApi(answer());
				const h = yield* connected(notion, { token: 'ntn_token' }),
					body = event('comment.created');
				const forged = webhook(body, { 'x-notion-signature': signature(body, '') });
				expect((yield* required(h.link.webhook)(forged)).status).toBe(401);
				expect(h.events).toEqual([]);
			})
	);
	it.live('reads an edit, a delete, and a mention by id or by name', () =>
		Effect.gen(function* () {
			const edited = comment({
				last_edited_time: '2026-11-01T11:00:00.000Z',
				rich_text: [{ plain_text: 'hi' }]
			});
			let found: object = edited;
			yield* platformApi((call) => answer(found)(call));
			const h = yield* connected(notion, settings);
			yield* required(h.link.webhook)(delivery(event('comment.updated')));
			yield* required(h.link.webhook)(delivery(event('comment.deleted')));
			found = comment({
				rich_text: [{ plain_text: '@x', mention: { type: 'user', user: { id: 'bot' } } }]
			});
			yield* required(h.link.webhook)(delivery(event('comment.created')));
			found = comment({ rich_text: [{ plain_text: 'ask @norbius' }] });
			yield* required(h.link.webhook)(delivery(event('comment.created')));
			found = comment({ rich_text: [{ plain_text: 'ask @norbius2' }] });
			yield* required(h.link.webhook)(delivery(event('comment.created')));
			expect(h.events[0]).toMatchObject({
				messages: [{ id: 'c1', text: 'hi', version: '2026-11-01T11:00:00.000Z' }]
			});
			expect(h.events[1]).toMatchObject({
				messages: [{ id: 'c1', thread: 'p1', deleted: true, text: '' }]
			});
			expect(h.events[2]).toMatchObject({ messages: [{ invocation: 'mention' }] });
			expect(h.events[3]).toMatchObject({ messages: [{ invocation: 'mention' }] });
			expect(h.events[4]).toMatchObject({ messages: [{ invocation: 'ambient' }] });
		})
	);
	it.live('stores nothing of its own, nothing gone, and no other event', () =>
		Effect.gen(function* () {
			let found: object | null = comment({ created_by: { id: 'bot' } });
			yield* platformApi((call) => answer(found)(call));
			const h = yield* connected(notion, settings);
			yield* required(h.link.webhook)(delivery(event('comment.created')));
			found = null;
			expect((yield* required(h.link.webhook)(delivery(event('comment.created')))).status).toBe(200);
			yield* required(h.link.webhook)(delivery(event('page.created')));
			expect(h.events).toEqual([]);
		})
	);
	it.live('fetches a comment file with no credential, and keeps only its name when refused', () =>
		Effect.gen(function* () {
			const files = comment({
				attachments: [{ category: 'image', file: { url: 'https://files.test/a' } }]
			});
			const api = yield* platformApi(answer(files));
			const h = yield* connected(notion, settings);
			yield* required(h.link.webhook)(delivery(event('comment.created')));
			expect(h.events[0]).toMatchObject({
				messages: [{ attachments: [{ name: 'image', bytes: 3, bin: 0 }] }],
				bins: [new Uint8Array([1, 2, 3])]
			});
			expect(api.calls.at(-1)?.headers.get('authorization')).toBeNull();
		})
	);
	it.live('sends a comment to the page, and the rest of a long one in its discussion', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer());
			const h = yield* connected(notion, settings);
			const sent = yield* required(h.link.send)({ to: 'p1', text: 'Done' }, []);
			expect(sent).toMatchObject({ provider_id: 'sent:4' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://api.notion.com/v1/comments');
			expect(call?.headers.get('authorization')).toBe('Bearer ntn_token');
			expect(call?.headers.get('notion-version')).toBe('2026-03-11');
			expect(JSON.parse(call?.body ?? '')).toEqual({ parent: { page_id: 'p1' }, markdown: 'Done' });
			const long = yield* required(h.link.send)({ to: 'p1', text: 'x'.repeat(2500) }, []);
			expect(long).toMatchObject({ provider_id: 'sent:1900' });
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toEqual({
				discussion_id: 'd9',
				markdown: 'x'.repeat(600)
			});
		})
	);
	it.live('a refused send fails for good, and a rate limit keeps its wait', () =>
		Effect.gen(function* () {
			let refusal = () => json({ code: 'validation_error' }, 400);
			yield* platformApi(({ url }) => (url.endsWith('/users/me') ? json(me) : refusal()));
			const h = yield* connected(notion, settings);
			const lost = yield* Effect.flip(required(h.link.send)({ to: 'p1', text: 'x' }, []));
			expect(lost).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			refusal = () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
			const held = yield* Effect.flip(required(h.link.send)({ to: 'p1', text: 'x' }, []));
			expect(held).toMatchObject({ _tag: 'ProviderUnavailable', retry_after_ms: 30_000 });
		})
	);
	it.live('a token Notion refuses fails pairing and keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ code: 'unauthorized' }, 401));
			const h = yield* host(chatProvider(notion), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
