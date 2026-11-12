// Velt: deliveries signed as Standard Webhooks signs them, and its REST API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider, type ChatHost } from '../../src/chat/adapter.ts';
import { velt } from '../../src/chat/velt/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const key = Buffer.alloc(24, 5);
const settings = {
	apiKey: 'velt_key',
	webhookSecret: `whsec_${key.toString('base64')}`,
	organizationId: 'org',
	botUserId: 'bot',
	botUserName: 'Norbius'
};
const thread = 'org:doc%2F1:ann';
const success = (data: unknown) => json({ result: { status: 'success', data } });
const comment = (extra: object = {}) => ({
	commentId: 11,
	commentText: 'hello',
	from: { userId: 'ada', name: 'Ada' },
	createdAt: 1_793_527_200_000,
	...extra
});
const answer =
	(annotations: object[] = []) =>
	({ url }: Call) => {
		if (url.endsWith('/v2/auth/generate_token')) return success({ token: 'jwt' });
		if (url.endsWith('/comments/add')) return success([77]);
		if (url.endsWith('/v2/commentannotations/get')) return success(annotations);
		return new Response(new Uint8Array([1, 2]));
	};
const hook = (event: string, data: object = {}) =>
	JSON.stringify({
		event,
		data: {
			commentAnnotation: { annotationId: 'ann' },
			targetComment: comment(),
			metadata: { organizationId: 'org', documentId: 'doc/1' },
			...data
		}
	});
const headers = (body: string, signing: Buffer = key, at = Math.floor(Date.now() / 1000)) => ({
	'webhook-id': 'msg_1',
	'webhook-timestamp': String(at),
	'webhook-signature': `v1,${createHmac('sha256', signing).update(`msg_1.${at}.${body}`).digest('base64')}`
});
const delivery = (body: string) => webhook(body, headers(body));
const history = (since: string) =>
	Effect.promise(async () =>
		required((
			await velt.connect(settings, {
				fetch,
				webhook_url: 'https://hook.test/',
				receive: async () => {}
			} satisfies ChatHost)
		).history)(thread, since)
	);

describe('Velt', () => {
	it.live('stores a signed comment before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(velt, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'Norbius' });
			expect((yield* required(h.link.webhook)(delivery(hook('comment.add')))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'ann:11',
						thread,
						sent_at: new Date(1_793_527_200_000).toISOString(),
						from: { handle: 'ada', name: 'Ada' },
						text: 'hello',
						group: true,
						invocation: 'ambient'
					}
				]
			});
		})
	);
	it.live('refuses a bad or a stale signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(velt, settings),
				body = hook('comment.add');
			const forged = webhook(body, headers(body, Buffer.alloc(24, 1)));
			expect((yield* required(h.link.webhook)(forged)).status).toBe(401);
			const old = webhook(body, headers(body, key, Math.floor(Date.now() / 1000) - 3600));
			expect((yield* required(h.link.webhook)(old)).status).toBe(401);
			expect((yield* required(h.link.webhook)(webhook(body, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a comment the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(velt, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* required(h.link.webhook)(delivery(hook('comment.add')))).status).toBe(500);
		})
	);
	it.live('reads an edit, a delete, a mention token, a first comment and a file', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(velt, settings);
			const edited = comment({ commentText: 'hi', isEdited: true, lastUpdated: 1_793_530_800_000 });
			yield* required(h.link.webhook)(delivery(hook('comment.update', { targetComment: edited })));
			yield* required(h.link.webhook)(delivery(hook('comment.delete')));
			const mention = comment({
				commentId: 12,
				commentText: 'ask {{bot}} and {{u2}}',
				to: [{ userId: 'bot', name: 'Norbius' }],
				taggedUserContacts: [{ userId: 'u2', contact: { userId: 'u2', name: 'Grace' } }]
			});
			yield* required(h.link.webhook)(delivery(hook('comment.add', { targetComment: mention })));
			const first = {
				commentAnnotation: {
					annotationId: 'ann',
					comments: [
						comment({
							commentId: 13,
							commentText: undefined,
							commentHtml: '<p>from <b>html</b></p>',
							attachments: [
								{ name: 'a.png', url: 'https://files.test/a', mimeType: 'image/png', size: 2 }
							]
						})
					]
				},
				targetComment: undefined
			};
			yield* required(h.link.webhook)(delivery(hook('comment_annotation.add', first)));
			expect(h.events[0]).toMatchObject({
				messages: [{ id: 'ann:11', text: 'hi', version: new Date(1_793_530_800_000).toISOString() }]
			});
			expect(h.events[1]).toMatchObject({ messages: [{ id: 'ann:11', deleted: true, text: '' }] });
			expect(h.events[2]).toMatchObject({
				messages: [{ id: 'ann:12', text: 'ask @Norbius and @Grace', invocation: 'mention' }]
			});
			expect(h.events[3]).toMatchObject({
				messages: [
					{
						id: 'ann:13',
						text: 'from html',
						attachments: [{ name: 'a.png', mime: 'image/png', bytes: 2, bin: 0 }]
					}
				],
				bins: [new Uint8Array([1, 2])]
			});
		})
	);
	it.live('stores nothing of its own, nothing unplaced, and no other event', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(velt, settings);
			for (const body of [
				hook('comment.add', { targetComment: comment({ from: { userId: 'bot' } }) }),
				hook('comment.add', { metadata: {} }),
				hook('comment.reaction_add')
			])
				expect((yield* required(h.link.webhook)(delivery(body))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('sends with a token it asked for once, naming the comment in its annotation', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer());
			const h = yield* connected(velt, settings);
			const sent = yield* required(h.link.send)({ to: thread, text: 'Done' }, []);
			yield* required(h.link.send)({ to: thread, text: 'Again' }, []);
			expect(sent).toMatchObject({ provider_id: 'ann:77' });
			expect(api.calls.filter(({ url }) => url.endsWith('/generate_token'))).toHaveLength(1);
			const call = api.calls.at(-2);
			expect(call?.url).toBe('https://api.velt.dev/v2/commentannotations/comments/add');
			expect(call?.headers.get('x-velt-api-key')).toBe('velt_key');
			expect(call?.headers.get('x-velt-auth-token')).toBe('jwt');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				data: {
					organizationId: 'org',
					documentId: 'doc/1',
					annotationId: 'ann',
					commentData: [{ commentText: 'Done', from: { userId: 'bot', name: 'Norbius' } }]
				}
			});
		})
	);
	it.live('keeps one token: another organization replaces it, and a refused one is remade', () =>
		Effect.gen(function* () {
			let refuse = 1;
			const api = yield* platformApi((call) => {
				if (!call.url.endsWith('/comments/add')) return answer()(call);
				return refuse-- > 0 ? json({}, 401) : success([77]);
			});
			const h = yield* connected(velt, settings);
			const made = () => api.calls.filter(({ url }) => url.endsWith('/generate_token')).length;
			expect(made()).toBe(1);
			yield* required(h.link.send)({ to: thread, text: 'x' }, []);
			expect(made()).toBe(2);
			yield* required(h.link.send)({ to: 'other:doc:ann', text: 'x' }, []);
			expect(made()).toBe(3);
			yield* required(h.link.send)({ to: thread, text: 'x' }, []);
			expect(made()).toBe(4);
		})
	);
	it.live('a refusal in the body fails for good', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.endsWith('/comments/add')
					? json({ result: { status: 'error', message: 'no such document' } })
					: answer()(call)
			);
			const h = yield* connected(velt, settings);
			const lost = yield* Effect.flip(required(h.link.send)({ to: thread, text: 'x' }, []));
			expect(lost).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
		})
	);
	it.live('a key Velt refuses, or an empty secret, fails pairing and keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: 'unauthorized' }, 401));
			const h = yield* host(chatProvider(velt), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			yield* Effect.flip(required(h.link.pair)({ ...settings, webhookSecret: 'whsec_' }));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('history is the annotation in its window, and complete', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(
				answer([
					{
						annotationId: 'ann',
						comments: [
							comment({ commentId: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
							comment({ commentId: 2, createdAt: '2026-11-01T10:00:00.000Z' }),
							comment({
								commentId: 3,
								from: { userId: 'bot' },
								createdAt: '2026-11-01T10:00:00.000Z'
							})
						]
					}
				])
			);
			const page = yield* history('2026-11-01T09:00:00.000Z');
			expect(page.complete).toBe(true);
			expect(page.messages.map(({ id }) => id)).toEqual(['ann:2']);
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toMatchObject({
				data: { organizationId: 'org', documentId: 'doc/1', annotationIds: ['ann'] }
			});
		})
	);
	it.live('an annotation that does not come back proves no delete', () =>
		Effect.gen(function* () {
			yield* platformApi(answer([]));
			const page = yield* history('2026-11-01T09:00:00.000Z');
			expect(page).toEqual({ messages: [], complete: false });
		})
	);
});
