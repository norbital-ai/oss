// Liveblocks: its real SDK, deliveries signed as Standard Webhooks signs them, and its REST API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider, type ChatHost } from '../../src/chat/adapter.ts';
import { liveblocks } from '../../src/chat/liveblocks/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const key = Buffer.alloc(24, 9);
const settings = {
	secretKey: 'sk_dev_abcdefghijklmnopqrstuvwxyz0123456789',
	webhookSecret: `whsec_${key.toString('base64')}`,
	botUserId: 'norbius'
};
const paragraph = (...children: object[]) => ({
	version: 1,
	content: [{ type: 'paragraph', children }]
});
const comment = (extra: object = {}) => ({
	type: 'comment',
	id: 'cm_1',
	threadId: 'th_1',
	roomId: 'team:room',
	userId: 'ada',
	createdAt: '2026-11-01T10:00:00.000Z',
	reactions: [],
	attachments: [],
	metadata: {},
	body: paragraph({ text: 'hello' }),
	...extra
});
const thread = (comments: object[]) => ({
	type: 'thread',
	id: 'th_1',
	roomId: 'team:room',
	createdAt: '2026-11-01T10:00:00.000Z',
	updatedAt: '2026-11-01T10:00:00.000Z',
	metadata: {},
	resolved: false,
	comments
});
const answer =
	(found: object | null = comment(), comments: object[] = []) =>
	({ url, body }: Call) => {
		const { pathname } = new URL(url);
		if (pathname === '/v2/rooms') return json({ data: [], nextCursor: null, nextPage: null });
		if (pathname.includes('/attachments/')) return json({ url: 'https://files.test/a' });
		if (url.startsWith('https://files.test')) return new Response(new Uint8Array([1, 2]));
		if (pathname.includes('/comments/'))
			return found === null ? json({ message: 'Not found' }, 404) : json(found);
		if (pathname.endsWith('/comments'))
			return json(comment({ id: 'cm_9', userId: 'norbius', ...JSON.parse(body) }));
		return json(thread(comments));
	};
const created = (type = 'commentCreated', data: object = {}) =>
	JSON.stringify({
		type,
		data: {
			projectId: 'pr_1',
			roomId: 'team:room',
			threadId: 'th_1',
			commentId: 'cm_1',
			createdAt: '2026-11-01T10:00:00.000Z',
			createdBy: 'ada',
			...data
		}
	});
const headers = (body: string, signing: Buffer = key) => {
	const at = String(Math.floor(Date.now() / 1000));
	return {
		'webhook-id': 'msg_1',
		'webhook-timestamp': at,
		'webhook-signature': `v1,${createHmac('sha256', signing).update(`msg_1.${at}.${body}`).digest('base64')}`
	};
};
const delivery = (body: string) => webhook(body, headers(body));
const history = (name: string, since: string) =>
	Effect.promise(async () =>
		(
			await liveblocks.connect(settings, {
				fetch,
				webhookUrl: 'https://hook.test/',
				receive: async () => {}
			} satisfies ChatHost)
		).history!(name, since)
	);

describe('Liveblocks', () => {
	it.live('reads back a signed comment and stores it before acknowledging', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(liveblocks, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'norbius' });
			expect((yield* h.link.webhook!(delivery(created()))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'cm_1',
						thread: 'team:room:th_1',
						sentAt: '2026-11-01T10:00:00.000Z',
						from: { handle: 'ada' },
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
			const h = yield* connected(liveblocks, settings),
				body = created();
			const forged = webhook(body, headers(body, Buffer.alloc(24, 1)));
			expect((yield* h.link.webhook!(forged)).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a comment the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(liveblocks, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* h.link.webhook!(delivery(created()))).status).toBe(500);
		})
	);
	it.live('reads an edit, a delete, a mention, a link and a file', () =>
		Effect.gen(function* () {
			const edited = comment({
				editedAt: '2026-11-01T11:00:00.000Z',
				body: paragraph(
					{ type: 'mention', kind: 'user', id: 'norbius' },
					{ text: ' see ' },
					{ type: 'link', url: 'https://x.test' }
				),
				attachments: [
					{ type: 'attachment', id: 'at_1', name: 'a.png', size: 2, mimeType: 'image/png' }
				]
			});
			yield* platformApi(answer(edited));
			const h = yield* connected(liveblocks, settings);
			const edit = created('commentEdited', { editedAt: '2026-11-01T11:00:00.000Z' });
			yield* h.link.webhook!(delivery(edit));
			const gone = created('commentDeleted', { deletedAt: '2026-11-01T12:00:00.000Z' });
			yield* h.link.webhook!(delivery(gone));
			expect(h.events[0]).toMatchObject({
				messages: [
					{
						id: 'cm_1',
						text: '@norbius see https://x.test',
						version: '2026-11-01T11:00:00.000Z',
						invocation: 'mention',
						attachments: [{ name: 'a.png', mime: 'image/png', bytes: 2, bin: 0 }]
					}
				],
				bins: [new Uint8Array([1, 2])]
			});
			expect(h.events[1]).toMatchObject({
				messages: [{ id: 'cm_1', thread: 'team:room:th_1', deleted: true, text: '' }]
			});
		})
	);
	it.live('stores nothing of its own, nothing gone by the read, and no other event', () =>
		Effect.gen(function* () {
			let found: object | null = comment({ userId: 'norbius' });
			yield* platformApi((call) => answer(found)(call));
			const h = yield* connected(liveblocks, settings);
			yield* h.link.webhook!(delivery(created()));
			found = null;
			expect((yield* h.link.webhook!(delivery(created()))).status).toBe(200);
			const resolved = JSON.stringify({
				type: 'threadMarkedAsResolved',
				data: {
					projectId: 'pr_1',
					roomId: 'team:room',
					threadId: 'th_1',
					updatedAt: '2026-11-01T10:00:00.000Z',
					updatedBy: 'ada'
				}
			});
			expect((yield* h.link.webhook!(delivery(resolved))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('sends a comment as the bot into the thread', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer());
			const h = yield* connected(liveblocks, settings);
			const sent = yield* h.link.send!({ to: 'team:room:th_1', text: 'Done' }, []);
			expect(sent).toMatchObject({ providerId: 'cm_9' });
			const call = api.calls.at(-1);
			expect(decodeURIComponent(call?.url ?? '')).toBe(
				'https://api.liveblocks.io/v2/rooms/team:room/threads/th_1/comments'
			);
			expect(call?.headers.get('authorization')).toBe(`Bearer ${settings.secretKey}`);
			expect(JSON.parse(call?.body ?? '')).toMatchObject({
				userId: 'norbius',
				body: { version: 1, content: [{ type: 'paragraph', children: [{ text: 'Done' }] }] }
			});
		})
	);
	it.live('a refused send fails for good', () =>
		Effect.gen(function* () {
			yield* platformApi(({ url }) =>
				new URL(url).pathname === '/v2/rooms'
					? json({ data: [], nextCursor: null })
					: json({ message: 'Forbidden' }, 403)
			);
			const h = yield* connected(liveblocks, settings);
			const lost = yield* Effect.flip(h.link.send!({ to: 'team:room:th_1', text: 'x' }, []));
			expect(lost).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
		})
	);
	it.live('a key Liveblocks refuses, or a secret of no shape, fails pairing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'Unauthorized' }, 401));
			const h = yield* host(chatProvider(liveblocks), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			yield* Effect.flip(h.link.pair!({ ...settings, webhookSecret: 'plain' }));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('history is the whole thread in its window, keeping what it marks deleted', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answer(null, [
					comment({ id: 'cm_old', createdAt: '2026-10-01T10:00:00.000Z' }),
					comment({ id: 'cm_1' }),
					comment({ id: 'cm_2', userId: 'norbius' }),
					comment({ id: 'cm_3', body: undefined, deletedAt: '2026-11-01T12:00:00.000Z' })
				])
			);
			const page = yield* history('team:room:th_1', '2026-11-01T09:00:00.000Z');
			expect(page.complete).toBe(true);
			expect(page.messages.map(({ id, deleted }) => [id, deleted])).toEqual([
				['cm_1', undefined],
				['cm_3', true]
			]);
		})
	);
	it.live('history of a thread out of reach fails, and proves no delete', () =>
		Effect.gen(function* () {
			yield* platformApi(({ url }) =>
				new URL(url).pathname === '/v2/rooms'
					? json({ data: [], nextCursor: null })
					: json({ message: 'Not found' }, 404)
			);
			const failed = yield* Effect.exit(history('team:room:th_1', '2026-11-01T09:00:00.000Z'));
			expect(failed._tag).toBe('Failure');
		})
	);
});
