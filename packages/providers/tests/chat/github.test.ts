// GitHub: its real Octokit, deliveries signed as GitHub signs them, and its REST API faked behind `fetch`.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider, type ChatHost } from '../../src/chat/adapter.ts';
import { github } from '../../src/chat/github/index.ts';
import { required, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { token: 'ghp_token', webhookSecret: 'secret' };
const me = { id: 1, login: 'norbius' };
const person = { id: 7, login: 'ada' };
const comment = (id: number, extra: object = {}) => ({
	id,
	body: 'hello',
	user: person,
	created_at: '2026-11-01T10:00:00Z',
	updated_at: '2026-11-01T10:00:00Z',
	...extra
});
const paged = (rows: object[], next?: string) =>
	new Response(JSON.stringify(rows), {
		headers: {
			'content-type': 'application/json',
			...(next === undefined ? {} : { link: `<${next}>; rel="next"` })
		}
	});
const answer = ({ url }: Call) => {
	const { pathname } = new URL(url);
	if (pathname === '/user') return json(me);
	if (pathname === '/repos/acme/web/issues/12/comments') return json({ id: 900, user: me });
	return json({});
};
const hook = (action: string, extra: object = {}) =>
	JSON.stringify({
		action,
		comment: comment(100),
		repository: { full_name: 'acme/web' },
		issue: { number: 12, title: 'Broken build' },
		...extra
	});
const signature = (body: string, secret = 'secret') =>
	`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const delivery = (body: string, event = 'issue_comment') =>
	webhook(body, { 'x-github-event': event, 'x-hub-signature-256': signature(body) });
const connection = () =>
	github.connect(settings, {
		fetch,
		webhook_url: 'https://hook.test/',
		receive: async () => {}
	} satisfies ChatHost);

describe('GitHub', () => {
	it.live('stores a signed comment before acknowledging it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(github, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'norbius' });
			expect((yield* required(h.link.webhook)(delivery(hook('created')))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: '100',
						thread: 'acme/web/issues/12',
						sent_at: '2026-11-01T10:00:00Z',
						from: { handle: '7', name: 'ada' },
						text: 'hello',
						title: 'Broken build',
						group: true,
						invocation: 'ambient'
					}
				]
			});
		})
	);
	it.live('refuses a bad signature and stores nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(github, settings),
				body = hook('created');
			const forged = webhook(body, {
				'x-github-event': 'issue_comment',
				'x-hub-signature-256': signature(body, 'guess')
			});
			expect((yield* required(h.link.webhook)(forged)).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a comment the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(github, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			expect((yield* required(h.link.webhook)(delivery(hook('created')))).status).toBe(500);
		})
	);
	it.live('reads an edit, a delete, a mention and a pull request', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(github, settings);
			const edited = comment(100, { body: 'hello!', updated_at: '2026-11-01T11:00:00Z' });
			yield* required(h.link.webhook)(delivery(hook('edited', { comment: edited })));
			yield* required(h.link.webhook)(delivery(hook('deleted')));
			yield* required(h.link.webhook)(
				delivery(
					hook('created', {
						comment: comment(101, { body: 'ping @Norbius please' }),
						issue: { number: 3, title: 'Fix', pull_request: {} }
					})
				)
			);
			expect(h.events[0]).toMatchObject({
				messages: [{ id: '100', text: 'hello!', version: '2026-11-01T11:00:00Z' }]
			});
			expect(h.events[1]).toMatchObject({ messages: [{ id: '100', deleted: true, text: '' }] });
			expect(h.events[2]).toMatchObject({
				messages: [{ id: '101', thread: 'acme/web/pull/3', invocation: 'mention' }]
			});
		})
	);
	it.live('a mention in code or a quote invokes nobody, and another name is not ours', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(github, settings);
			for (const body of ['`@norbius`', '> @norbius said', '@norbius-two', 'a@norbius'])
				yield* required(h.link.webhook)(delivery(hook('created', { comment: comment(1, { body }) })));
			expect(h.events).toHaveLength(4);
			for (const event of h.events)
				expect(event).toMatchObject({ messages: [{ invocation: 'ambient' }] });
		})
	);
	it.live('a review comment keeps its own id and names what it answers', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(github, settings);
			const body = JSON.stringify({
				action: 'created',
				comment: comment(100, { in_reply_to_id: 99 }),
				repository: { full_name: 'acme/web' },
				pull_request: { number: 3, title: 'Fix' }
			});
			yield* required(h.link.webhook)(delivery(body, 'pull_request_review_comment'));
			expect(h.events[0]).toMatchObject({
				messages: [{ id: 'review:100', reply_to: 'review:99', thread: 'acme/web/pull/3' }]
			});
		})
	);
	it.live('ignores its own comments, a ping and an action that is no message', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(github, settings);
			yield* required(h.link.webhook)(delivery(hook('created', { comment: comment(1, { user: me }) })));
			yield* required(h.link.webhook)(delivery(hook('pinned')));
			const ping = yield* required(h.link.webhook)(delivery('{"zen":"Keep it simple"}', 'ping'));
			expect(ping.status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('sends a comment to the thread', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(github, settings);
			const sent = yield* required(h.link.send)({ to: 'acme/web/issues/12', text: 'Done' }, []);
			expect(sent).toMatchObject({ provider_id: '900' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe('https://api.github.com/repos/acme/web/issues/12/comments');
			expect(call?.headers.get('authorization')).toBe('token ghp_token');
			expect(JSON.parse(call?.body ?? '')).toEqual({ body: 'Done' });
		})
	);
	it.live('a refused send fails for good, and a rate limit stays retryable', () =>
		Effect.gen(function* () {
			let refusal = json({ message: 'Not Found' }, 404);
			yield* platformApi(({ url }) =>
				new URL(url).pathname === '/user' ? json(me) : refusal.clone()
			);
			const h = yield* connected(github, settings);
			const lost = yield* Effect.flip(required(h.link.send)({ to: 'acme/web/issues/12', text: 'x' }, []));
			expect(lost).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			refusal = new Response('{"message":"slow down"}', {
				status: 403,
				headers: { 'content-type': 'application/json', 'retry-after': '30' }
			});
			const held = yield* Effect.flip(required(h.link.send)({ to: 'acme/web/issues/12', text: 'x' }, []));
			expect(held).toMatchObject({ _tag: 'ProviderUnavailable', retry_after_ms: 30_000 });
			const wrong = yield* Effect.flip(required(h.link.send)({ to: 'acme/web', text: 'x' }, []));
			expect(wrong).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
		})
	);
	it.live('a token GitHub refuses fails pairing and keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'Bad credentials' }, 401));
			const h = yield* host(chatProvider(github), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('history of an issue is complete when one page holds the window', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(({ url }) =>
				new URL(url).pathname === '/user'
					? json(me)
					: paged([comment(100), comment(101, { user: me })])
			);
			const page = yield* Effect.promise(async () =>
				required((await connection()).history)('acme/web/issues/12', '2026-11-01T09:00:00.500Z')
			);
			expect(page.complete).toBe(true);
			expect(page.messages.map(({ id }) => id)).toEqual(['100']);
			const asked = new URL(api.calls.at(-1)?.url ?? '');
			expect(asked.pathname).toBe('/repos/acme/web/issues/12/comments');
			expect(asked.searchParams.get('since')).toBe('2026-11-01T08:59:59Z');
		})
	);
	it.live('history of a pull request reads both kinds of comment', () =>
		Effect.gen(function* () {
			yield* platformApi(({ url }) => {
				const { pathname } = new URL(url);
				return pathname === '/user'
					? json(me)
					: paged(
							pathname.includes('/pulls/') ? [comment(100, { in_reply_to_id: 99 })] : [comment(100)]
						);
			});
			const page = yield* Effect.promise(async () =>
				required((await connection()).history)('acme/web/pull/3', '2026-11-01T09:00:00Z')
			);
			expect(page.complete).toBe(true);
			expect(page.messages.map(({ id }) => id)).toEqual(['100', 'review:100']);
		})
	);
	it.live('a listing of two pages repairs what it shows and proves no delete', () =>
		Effect.gen(function* () {
			yield* platformApi(({ url }) => {
				const parsed = new URL(url);
				if (parsed.pathname === '/user') return json(me);
				return parsed.searchParams.get('page') === '2'
					? paged([comment(101)])
					: paged([comment(100)], `${parsed.origin}${parsed.pathname}?page=2`);
			});
			const page = yield* Effect.promise(async () =>
				required((await connection()).history)('acme/web/issues/12', '2026-11-01T09:00:00Z')
			);
			expect(page.complete).toBe(false);
			expect(page.messages.map(({ id }) => id)).toEqual(['100', '101']);
		})
	);
});
