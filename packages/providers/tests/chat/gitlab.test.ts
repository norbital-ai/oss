// GitLab: deliveries signed as Standard Webhooks signs them, and its REST API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider, type ChatHost } from '../../src/chat/adapter.ts';
import { gitlab } from '../../src/chat/gitlab/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const key = Buffer.alloc(32, 7);
const settings = { token: 'glpat', webhookSigningToken: `whsec_${key.toString('base64')}` };
const me = { id: 1, username: 'nor.bius', name: 'Norbius' };
const person = { id: 7, username: 'ada', name: 'Ada' };
const answer = ({ url, body }: Call) =>
	url.endsWith('/user') ? json(me) : body === '' ? json([]) : json({ id: 900 }, 201);
const hook = (attributes: object = {}, extra: object = {}) =>
	JSON.stringify({
		object_kind: 'note',
		project_id: 42,
		project: { id: 42 },
		user: person,
		object_attributes: {
			id: 100,
			note: 'hello',
			noteable_type: 'MergeRequest',
			action: 'create',
			created_at: '2026-11-01 10:00:00 UTC',
			updated_at: '2026-11-01 10:00:00 UTC',
			...attributes
		},
		merge_request: { iid: 7, title: 'Fix the build' },
		...extra
	});
const delivery = (body: string, at = Math.floor(Date.now() / 1000), event = 'Note Hook') =>
	webhook(body, {
		'x-gitlab-event': event,
		'webhook-id': 'msg_1',
		'webhook-timestamp': String(at),
		'webhook-signature': `v1,${createHmac('sha256', key).update(`msg_1.${at}.${body}`).digest('base64')}`
	});
const note = (id: number, created_at: string, extra: object = {}) => ({
	id,
	body: `note ${id}`,
	author: person,
	created_at,
	updated_at: created_at,
	...extra
});
const listing = (rows: object[], next = '') =>
	new Response(JSON.stringify(rows), {
		headers: { 'content-type': 'application/json', 'x-next-page': next }
	});
const history = (thread: string, since: string) =>
	Effect.promise(async () =>
		(
			await gitlab.connect(settings, {
				fetch,
				webhookUrl: 'https://hook.test/',
				receive: async () => {}
			} satisfies ChatHost)
		).history!(thread, since)
	);
const notes =
	(rows: Response) =>
	({ url }: Call) =>
		url.endsWith('/user') ? json(me) : rows.clone();

describe('GitLab', () => {
	it.live('stores a signed note before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gitlab, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'nor.bius' });
			expect((yield* h.link.webhook!(delivery(hook()))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: '100',
						thread: '42/merge_requests/7',
						sentAt: '2026-11-01T10:00:00.000Z',
						from: { handle: '7', name: 'Ada' },
						text: 'hello',
						title: 'Fix the build',
						group: true,
						invocation: 'ambient'
					}
				]
			});
		})
	);
	it.live('refuses a bad or a stale signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gitlab, settings),
				body = hook();
			const forged = delivery(body);
			forged.headers.set('webhook-signature', 'v1,Zm9yZ2Vk');
			expect((yield* h.link.webhook!(forged)).status).toBe(401);
			const old = Math.floor(Date.now() / 1000) - 3600;
			expect((yield* h.link.webhook!(delivery(body, old))).status).toBe(401);
			const unsigned = webhook(body, { 'x-gitlab-event': 'Note Hook' });
			expect((yield* h.link.webhook!(unsigned)).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a note the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gitlab, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* h.link.webhook!(delivery(hook()))).status).toBe(500);
		})
	);
	it.live('reads an edit, a mention, a thread of two names, and an issue', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gitlab, settings);
			yield* h.link.webhook!(
				delivery(hook({ action: 'update', note: 'hi', updated_at: '2026-11-01 11:00:00 UTC' }))
			);
			yield* h.link.webhook!(
				delivery(
					hook(
						{ id: 101, note: 'ping @nor.bius', noteable_type: 'Issue' },
						{ merge_request: undefined, issue: { iid: 3, title: 'Bug' }, project_id: undefined }
					)
				)
			);
			yield* h.link.webhook!(delivery(hook({ id: 102, note: 'ping @norxbius or `@nor.bius`' })));
			expect(h.events[0]).toMatchObject({
				messages: [{ id: '100', text: 'hi', version: '2026-11-01T11:00:00.000Z' }]
			});
			expect(h.events[1]).toMatchObject({
				messages: [{ id: '101', thread: '42/issues/3', invocation: 'mention' }]
			});
			expect(h.events[2]).toMatchObject({ messages: [{ id: '102', invocation: 'ambient' }] });
		})
	);
	it.live('stores no note of its own, no system note and nothing confidential', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gitlab, settings);
			for (const body of [
				hook({}, { user: me }),
				hook({ system: true }),
				hook({ internal: true }),
				hook({}, { event_type: 'confidential_note' }),
				hook({ noteable_type: 'Issue' }, { issue: { iid: 3, title: 'x', confidential: true } }),
				hook({ noteable_type: 'Snippet' })
			])
				expect((yield* h.link.webhook!(delivery(body))).status).toBe(200);
			yield* h.link.webhook!(delivery('{}', undefined, 'Push Hook'));
			expect(h.events).toEqual([]);
		})
	);
	it.live('sends a note to the thread', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(gitlab, settings);
			const sent = yield* h.link.send!({ to: '42/merge_requests/7', text: 'Done' }, []);
			expect(sent).toMatchObject({ providerId: '900' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://gitlab.com/api/v4/projects/42/merge_requests/7/notes');
			expect(call?.headers.get('authorization')).toBe('Bearer glpat');
			expect(JSON.parse(call?.body ?? '')).toEqual({ body: 'Done' });
		})
	);
	it.live('a thread that is no thread reaches no path of the API', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(gitlab, settings);
			const made = api.calls.length;
			const wrong = yield* Effect.flip(h.link.send!({ to: '42/../../users', text: 'x' }, []));
			expect(wrong).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			expect(api.calls).toHaveLength(made);
		})
	);
	it.live('a rate limit keeps its wait', () =>
		Effect.gen(function* () {
			yield* platformApi(({ url }) =>
				url.endsWith('/user')
					? json(me)
					: new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
			);
			const h = yield* connected(gitlab, settings);
			const held = yield* Effect.flip(h.link.send!({ to: '42/issues/3', text: 'x' }, []));
			expect(held).toMatchObject({ _tag: 'ProviderUnavailable', retryAfterMs: 30_000 });
		})
	);
	it.live('a token GitLab refuses and a signing token of no shape fail pairing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: '401 Unauthorized' }, 401));
			const h = yield* host(chatProvider(gitlab), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			yield* Effect.flip(h.link.pair!({ ...settings, webhookSigningToken: 'whsec_short' }));
			expect(h.values.size).toBe(0);
		})
	);
	it.live(
		'history is oldest first, without its own or hidden notes, and complete past the window',
		() =>
			Effect.gen(function* () {
				const api = yield* platformApi(
					notes(
						listing(
							[
								note(104, '2026-11-01T13:00:00.000Z', { updated_at: '2026-11-01T14:00:00.000Z' }),
								note(103, '2026-11-01T12:00:00.000Z', { author: me }),
								note(102, '2026-11-01T11:30:00.000Z', { system: true }),
								note(101, '2026-11-01T11:00:00.000Z', { internal: true }),
								note(100, '2026-11-01T10:00:00.000Z'),
								note(99, '2026-11-01T08:00:00.000Z')
							],
							'2'
						)
					)
				);
				const page = yield* history('42/issues/3', '2026-11-01T10:00:00.000Z');
				expect(page.complete).toBe(true);
				expect(page.messages.map(({ id }) => id)).toEqual(['100', '104']);
				expect(page.messages[1]).toMatchObject({ version: '2026-11-01T14:00:00.000Z' });
				const asked = new URL(api.calls.at(-1)?.url ?? '');
				expect(asked.pathname).toBe('/api/v4/projects/42/issues/3/notes');
				expect(Object.fromEntries(asked.searchParams)).toMatchObject({
					order_by: 'created_at',
					sort: 'desc'
				});
			})
	);
	it.live('a thread with no next page is complete, and a window running past the page is not', () =>
		Effect.gen(function* () {
			const rows = [note(100, '2026-11-01T10:00:00.000Z')];
			yield* platformApi(notes(listing(rows)));
			expect((yield* history('42/issues/3', '2026-11-01T09:00:00.000Z')).complete).toBe(true);
			yield* platformApi(notes(listing(rows, '2')));
			expect((yield* history('42/issues/3', '2026-11-01T09:00:00.000Z')).complete).toBe(false);
		})
	);
});
