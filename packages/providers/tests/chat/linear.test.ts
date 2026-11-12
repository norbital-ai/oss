// Linear: its real SDK, deliveries signed as Linear signs them, and its GraphQL API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { chatProvider, type ChatHost } from '../../src/chat/adapter.ts';
import { linear } from '../../src/chat/linear/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { apiKey: 'lin_api_key', webhookSecret: 'secret' };
const me = { id: 'U0', displayName: 'norbius', name: 'Norbius', email: 'n@x.test' };
const person = {
	id: 'U1',
	name: 'Ada',
	email: 'a@x.test',
	url: 'https://linear.app/x/profiles/ada'
};
const stamp = (at: string) => ({ createdAt: at, updatedAt: at });
const node = (id: string, extra: object = {}) => ({
	id,
	body: `comment ${id}`,
	user: { id: 'U1' },
	reactions: [],
	...stamp('2026-11-01T10:00:00.000Z'),
	...extra
});
type Answers = {
	readonly comments?: (after: unknown) => object;
	readonly create?: () => Response;
	readonly found?: boolean;
};
const answer =
	({ comments, create, found }: Answers = {}) =>
	({ body }: Call) => {
		const { query, variables } = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ query: Schema.String, variables: Schema.JsonObject })))(body);
		if (/mutation createComment/.test(query))
			return (
				create?.() ??
				json({
					data: {
						commentCreate: { success: true, lastSyncId: 1, comment: { id: Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(variables['input']).id } }
					}
				})
			);
		if (/query comments\(/.test(query))
			return json({ data: { comments: comments?.(variables['after']) } });
		if (/query issue\(/.test(query))
			return json({
				data: {
					issue: {
						id: 'I1',
						title: 'Bug',
						sharedAccess: { isShared: false, sharedWithUsers: [] },
						reactions: [],
						labelIds: [],
						previousIdentifiers: [],
						...stamp('2026-01-01T00:00:00.000Z')
					}
				}
			});
		if (/query comment\(/.test(query))
			return found === true
				? json({ data: { comment: node('C9') } })
				: json(
						{ errors: [{ message: 'Entity not found', extensions: { type: 'invalid input' } }] },
						400
					);
		return json({ data: { viewer: { ...me, ...stamp('2026-01-01T00:00:00.000Z') } } });
	};
const hook = (action: string, data: object = {}, extra: object = {}) =>
	JSON.stringify({
		action,
		type: 'Comment',
		organizationId: 'O1',
		webhookId: 'W1',
		webhookTimestamp: Date.now(),
		createdAt: '2026-11-01T10:00:00.000Z',
		data: {
			id: 'C1',
			body: 'hello',
			issueId: 'I1',
			issue: { id: 'I1', title: 'Bug' },
			userId: 'U1',
			user: person,
			...stamp('2026-11-01T10:00:00.000Z'),
			...data
		},
		...extra
	});
const signature = (body: string, secret = 'secret') =>
	createHmac('sha256', secret).update(body).digest('hex');
const delivery = (body: string) => webhook(body, { 'linear-signature': signature(body) });
const history = (since: string) =>
	Effect.promise(async () =>
		required((
			await linear.connect(settings, {
				fetch,
				webhook_url: 'https://hook.test/',
				receive: async () => {}
			} satisfies ChatHost)
		).history)('I1', since)
	);

describe('Linear', () => {
	it.live('stores a signed comment before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(linear, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'norbius' });
			expect((yield* required(h.link.webhook)(delivery(hook('create')))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'C1',
						thread: 'I1',
						sent_at: '2026-11-01T10:00:00.000Z',
						from: { handle: 'U1', name: 'Ada' },
						text: 'hello',
						title: 'Bug',
						group: true,
						invocation: 'ambient'
					}
				]
			});
		})
	);
	it.live('refuses a bad signature or a replay and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(linear, settings),
				body = hook('create');
			const forged = webhook(body, { 'linear-signature': signature(body, 'guess') });
			expect((yield* required(h.link.webhook)(forged)).status).toBe(401);
			const old = hook('create', {}, { webhookTimestamp: Date.now() - 120_000 });
			expect((yield* required(h.link.webhook)(delivery(old))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a comment the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(linear, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* required(h.link.webhook)(delivery(hook('create')))).status).toBe(500);
		})
	);
	it.live('reads an edit, a delete, a mention and a reply to it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(linear, settings);
			const edit = { body: 'hi', editedAt: '2026-11-01T11:00:00.000Z' };
			yield* required(h.link.webhook)(delivery(hook('update', edit, { updatedFrom: { body: 'hello' } })));
			yield* required(h.link.webhook)(delivery(hook('remove')));
			yield* required(h.link.webhook)(delivery(hook('create', { id: 'C2', body: 'ping @Norbius' })));
			yield* required(h.link.webhook)(
				delivery(hook('create', { id: 'C3', parentId: 'C0', parent: { id: 'C0', userId: 'U0' } }))
			);
			expect(h.events[0]).toMatchObject({
				messages: [{ id: 'C1', text: 'hi', version: '2026-11-01T11:00:00.000Z' }]
			});
			expect(h.events[1]).toMatchObject({ messages: [{ id: 'C1', deleted: true, text: '' }] });
			expect(h.events[2]).toMatchObject({ messages: [{ id: 'C2', invocation: 'mention' }] });
			expect(h.events[3]).toMatchObject({
				messages: [{ id: 'C3', reply_to: 'C0', invocation: 'reply' }]
			});
		})
	);
	it.live('stores nothing of its own, of an app, off an issue, or for an update of no text', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(linear, settings);
			for (const body of [
				hook('create', { userId: 'U0', user: { ...person, id: 'U0' } }),
				hook('create', { userId: undefined, user: undefined }),
				hook('create', { issueId: undefined, issue: undefined }),
				hook('update', {}, { updatedFrom: { resolvedAt: null } }),
				hook('create', {}, { type: 'Issue' })
			])
				expect((yield* required(h.link.webhook)(delivery(body))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('sends under an id drawn from the key, so a resend names the same comment', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer());
			const h = yield* connected(linear, settings);
			const first = yield* required(h.link.send)({ id: 'r1', to: 'I1', text: 'Done' }, []);
			const body = api.calls.at(-1)?.body ?? '';
			const { input } = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ variables: Schema.Struct({ input: Schema.Record(Schema.String, Schema.String) }) })))(body).variables;
			expect(input).toMatchObject({ issueId: 'I1', body: 'Done' });
			expect(input['id']).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/
			);
			expect(first).toEqual({ provider_id: input['id'] });
			expect(api.calls.at(-1)?.headers.get('authorization')).toBe('lin_api_key');
			expect(yield* required(h.link.send)({ id: 'r1', to: 'I1', text: 'Done' }, [])).toEqual(first);
			expect(yield* required(h.link.send)({ id: 'r2', to: 'I1', text: 'Done' }, [])).not.toEqual(first);
		})
	);
	it.live('a resend that finds its id taken is the comment that landed', () =>
		Effect.gen(function* () {
			const taken = () =>
				json({ errors: [{ message: 'id taken', extensions: { type: 'invalid input' } }] }, 400);
			yield* platformApi(answer({ create: taken, found: true }));
			const h = yield* connected(linear, settings);
			const sent = yield* required(h.link.send)({ id: 'r1', to: 'I1', text: 'Done' }, []);
			expect(sent).toMatchObject({ provider_id: expect.any(String) });
		})
	);
	it.live('a refused send fails for good, and a rate limit stays retryable', () =>
		Effect.gen(function* () {
			let refusal = json(
				{ errors: [{ message: 'no', extensions: { type: 'invalid input' } }] },
				400
			);
			yield* platformApi(answer({ create: () => refusal.clone() }));
			const h = yield* connected(linear, settings);
			const lost = yield* Effect.flip(required(h.link.send)({ id: 'r1', to: 'I1', text: 'x' }, []));
			expect(lost).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			refusal = new Response(
				'{"errors":[{"message":"slow","extensions":{"type":"ratelimited"}}]}',
				{
					status: 400,
					headers: { 'content-type': 'application/json', 'retry-after': '30' }
				}
			);
			const held = yield* Effect.flip(required(h.link.send)({ id: 'r2', to: 'I1', text: 'x' }, []));
			expect(held).toMatchObject({ _tag: 'ProviderUnavailable', retry_after_ms: 30_000 });
		})
	);
	it.live('a key Linear refuses fails pairing and keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ errors: [{ message: 'Authentication required' }] }, 401));
			const h = yield* host(chatProvider(linear), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live(
		'history asks for the window of the issue, archived comments in it, and is complete',
		() =>
			Effect.gen(function* () {
				const api = yield* platformApi(
					answer({
						comments: () => ({
							nodes: [
								node('C1', { editedAt: '2026-11-01T11:00:00.000Z', parentId: 'C0' }),
								node('C2', { user: { id: 'U0' } }),
								node('C3', { user: null, botActor: { id: 'B1' } })
							],
							pageInfo: { hasNextPage: false, hasPreviousPage: false }
						})
					})
				);
				const page = yield* history('2026-11-01T09:00:00.000Z');
				expect(page.complete).toBe(true);
				expect(page.messages).toEqual([
					expect.objectContaining({
						id: 'C1',
						thread: 'I1',
						reply_to: 'C0',
						version: '2026-11-01T11:00:00.000Z',
						from: { handle: 'U1', name: null }
					})
				]);
				const { variables } = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ variables: Schema.JsonObject })))(api.calls.at(-1)?.body ?? '');
				expect(variables).toMatchObject({
					includeArchived: true,
					filter: { issue: { id: { eq: 'I1' } }, updatedAt: { gte: '2026-11-01T09:00:00.000Z' } }
				});
			})
	);
	it.live('history follows the cursor, and two pages prove no delete', () =>
		Effect.gen(function* () {
			const asked: unknown[] = [];
			yield* platformApi(
				answer({
					comments: (after) => {
						asked.push(after);
						return {
							nodes: [node(`C${asked.length}`)],
							pageInfo: { hasNextPage: asked.length < 2, hasPreviousPage: false, endCursor: 'c1' }
						};
					}
				})
			);
			const page = yield* history('2026-11-01T09:00:00.000Z');
			expect(asked).toEqual([undefined, 'c1']);
			expect(page.messages.map(({ id }) => id)).toEqual(['C1', 'C2']);
			expect(page.complete).toBe(false);
		})
	);
	it.live('history stops at its last page', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answer({
					comments: () => ({
						nodes: [node('C1')],
						pageInfo: { hasNextPage: true, hasPreviousPage: false, endCursor: 'c1' }
					})
				})
			);
			const page = yield* history('2026-11-01T09:00:00.000Z');
			expect(page.messages).toHaveLength(10);
			expect(page.complete).toBe(false);
		})
	);
	it.live('history of an issue out of reach fails, though its filter would answer empty', () =>
		Effect.gen(function* () {
			const empty = () => ({
				nodes: [],
				pageInfo: { hasNextPage: false, hasPreviousPage: false }
			});
			yield* platformApi((call) =>
				/query issue\(/.test(call.body)
					? json({ errors: [{ message: 'Entity not found' }] }, 400)
					: answer({ comments: empty })(call)
			);
			const failed = yield* Effect.exit(history('2026-11-01T09:00:00.000Z'));
			expect(failed._tag).toBe('Failure');
		})
	);
});
