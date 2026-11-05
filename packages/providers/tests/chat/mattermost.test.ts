// Mattermost: its REST API faked behind `fetch`, and its event socket faked behind the global `WebSocket`.
import { afterEach, beforeEach, describe, expect, it, vi } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider, type ChatHost, type Incoming } from '../../src/chat/adapter.ts';
import { mattermost } from '../../src/chat/mattermost/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = { baseUrl: 'https://mm.test/', botToken: 'token' };
class FakeSocket extends EventTarget {
	static all: FakeSocket[] = [];
	static OPEN = 1;
	readonly readyState = 1;
	readonly sent: string[] = [];
	readonly url: string;
	constructor(url: string) {
		super();
		this.url = url;
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.dispatchEvent(new Event('close'));
	}
	frame(value: object) {
		this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
	}
}
const post = (extra: object = {}) => ({
	id: 'p1',
	channel_id: 'c1',
	root_id: '',
	user_id: 'u1',
	message: 'hello',
	type: '',
	create_at: 1_790_000_000_000,
	edit_at: 0,
	delete_at: 0,
	...extra
});
const event = (name: string, value: object, data: object = {}) => ({
	event: name,
	data: { post: JSON.stringify(value), channel_type: 'O', sender_name: '@ann', ...data }
});
const answer = ({ url, body }: Call) => {
	if (url.endsWith('/users/me')) return json({ id: 'bot', username: 'acme.bot' });
	if (url.endsWith('/posts/r1')) return json(post({ id: 'r1', user_id: 'bot' }));
	if (url.endsWith('/posts') && body !== '') return json({ id: 'out1' });
	if (url.endsWith('/channels/direct')) return json({ id: 'dm1' });
	if (url.endsWith('/files/f1')) return new Response(new Uint8Array([7, 8]));
	return json({});
};
const fetched = (call: (url: string, body: string) => Response) =>
	(async (input: RequestInfo | URL, init?: RequestInit) =>
		call(String(input), typeof init?.body === 'string' ? init.body : '')) as typeof fetch;
const hostOf = (
	receive: ChatHost['receive'],
	fetch: typeof globalThis.fetch = fetched((url, body) =>
		answer({ url, body, headers: new Headers() })
	)
): ChatHost => ({ fetch, webhookUrl: 'https://hook.test/', receive });
const socket = () => FakeSocket.all.at(-1)!;

describe('Mattermost', () => {
	beforeEach(() => {
		FakeSocket.all = [];
		vi.stubGlobal('WebSocket', FakeSocket);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});
	it.live('authenticates its socket and stores a post with exact fields', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(mattermost, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'acme.bot' });
			expect(socket().url).toBe('wss://mm.test/api/v4/websocket');
			socket().dispatchEvent(new Event('open'));
			expect(JSON.parse(socket().sent[0] ?? '')).toEqual({
				seq: 1,
				action: 'authentication_challenge',
				data: { token: 'token' }
			});
			socket().frame({ seq_reply: 1, status: 'OK' });
			socket().frame(
				event(
					'posted',
					post({
						root_id: 'r1',
						metadata: { files: [{ id: 'f1', name: 'a.png', mime_type: 'image/png', size: 2 }] }
					}),
					{ mentions: '["u9"]', channel_display_name: 'Town' }
				)
			);
			yield* Effect.promise(() => vi.waitFor(() => expect(h.events.length).toBe(1)));
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				bins: [new Uint8Array([7, 8])],
				messages: [
					{
						id: 'p1',
						thread: 'c1:r1',
						sentAt: new Date(1_790_000_000_000).toISOString(),
						from: { handle: 'u1', name: 'ann' },
						text: 'hello',
						group: true,
						title: 'Town',
						replyTo: 'r1',
						invocation: 'reply',
						attachments: [{ name: 'a.png', mime: 'image/png', bytes: 2, bin: 0 }]
					}
				]
			});
		})
	);
	it.live('a mention, a direct message, an edit and a delete', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(mattermost, settings);
			socket().frame(event('posted', post({ id: 'a', message: 'hi @acme.bot' })));
			socket().frame(event('posted', post({ id: 'b' }), { mentions: '["bot"]' }));
			socket().frame(event('posted', post({ id: 'c' }), { channel_type: 'D' }));
			socket().frame(event('post_edited', post({ id: 'd', edit_at: 1_790_000_009_000 })));
			socket().frame(event('post_deleted', post({ id: 'e', delete_at: 1_790_000_009_000 })));
			yield* Effect.promise(() => vi.waitFor(() => expect(h.events.length).toBe(5)));
			expect(h.events).toMatchObject([
				{ messages: [{ id: 'a', invocation: 'mention' }] },
				{ messages: [{ id: 'b', invocation: 'mention' }] },
				{ messages: [{ id: 'c', group: false, invocation: 'direct' }] },
				{ messages: [{ id: 'd', version: new Date(1_790_000_009_000).toISOString() }] },
				{ messages: [{ id: 'e', deleted: true, text: '' }] }
			]);
		})
	);
	it.live('skips its own posts, system posts and other events', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(mattermost, settings);
			socket().frame(event('posted', post({ user_id: 'bot' })));
			socket().frame(event('posted', post({ type: 'system_join_channel' })));
			socket().frame(event('typing', post()));
			socket().frame({ event: 'hello', data: {} });
			yield* Effect.sleep('20 millis');
			expect(h.events).toEqual([]);
		})
	);
	it.live('no webhook is believed', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(mattermost, settings);
			expect((yield* h.link.webhook!(webhook('{}', {}))).status).toBe(401);
		})
	);
	it.live('posts into a channel and a thread, and opens a direct channel', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(mattermost, settings);
			expect(yield* h.link.send!({ id: 'k', to: 'c1:r1', text: 'Hello' }, [])).toMatchObject({
				providerId: 'out1'
			});
			expect(api.calls.at(-1)?.url).toBe('https://mm.test/api/v4/posts');
			expect(api.calls.at(-1)?.headers.get('authorization')).toBe('Bearer token');
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toEqual({
				channel_id: 'c1',
				root_id: 'r1',
				message: 'Hello'
			});
			yield* h.link.test!({ to: 'u1' });
			expect(JSON.parse(api.calls.at(-2)?.body ?? '')).toEqual(['bot', 'u1']);
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toMatchObject({ channel_id: 'dm1' });
		})
	);
	it.live('a token Mattermost refuses keeps nothing and opens no socket', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ message: 'unauthorized' }, 401));
			const h = yield* host(chatProvider(mattermost), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
			expect(FakeSocket.all).toEqual([]);
		})
	);
	it('a refused store is not kept: the socket reconnects with backoff, and close leaves no timer', async () => {
		vi.useFakeTimers();
		const received: (readonly Incoming[])[] = [];
		const connection = await mattermost.connect(
			settings,
			hostOf((messages) => {
				received.push(messages);
				return Promise.reject(new Error('the store refused'));
			})
		);
		const first = socket();
		first.frame(event('posted', post()));
		await vi.advanceTimersByTimeAsync(0);
		expect(received.length).toBe(1);
		expect(FakeSocket.all.length).toBe(1);
		expect(vi.getTimerCount()).toBe(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(FakeSocket.all.length).toBe(2);
		socket().close();
		await vi.advanceTimersByTimeAsync(1000);
		expect(FakeSocket.all.length).toBe(2);
		await vi.advanceTimersByTimeAsync(2000);
		expect(FakeSocket.all.length).toBe(3);
		socket().close();
		expect(vi.getTimerCount()).toBe(2);
		await connection.close!();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(FakeSocket.all.length).toBe(3);
	});
	it('a socket that stops answering pings is replaced', async () => {
		vi.useFakeTimers();
		const connection = await mattermost.connect(
			settings,
			hostOf(() => Promise.resolve())
		);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(socket().sent.at(-1)).toContain('"ping"');
		await vi.advanceTimersByTimeAsync(130_000);
		expect(FakeSocket.all.length).toBeGreaterThan(1);
		await connection.close!();
		expect(vi.getTimerCount()).toBe(0);
	});
	it('close during a connection ends it for good', async () => {
		const connection = await mattermost.connect(
			settings,
			hostOf(() => Promise.resolve())
		);
		const closing = vi.spyOn(socket(), 'close');
		await connection.close!();
		expect(closing).toHaveBeenCalled();
		expect(FakeSocket.all.length).toBe(1);
	});
	it('history reads a whole thread, and a channel until the window ends', async () => {
		const urls: string[] = [];
		const list = (...posts: ReturnType<typeof post>[]) =>
			json({
				order: posts.map((one) => one.id),
				posts: Object.fromEntries(posts.map((one) => [one.id, one]))
			});
		const connection = await mattermost.connect(
			settings,
			hostOf(
				() => Promise.resolve(),
				fetched((url) => {
					urls.push(url);
					if (url.endsWith('/users/me')) return json({ id: 'bot', username: 'acme' });
					if (url.endsWith('/channels/c1')) return json({ type: 'O' });
					if (url.endsWith('/posts/r1/thread'))
						return list(
							post({ id: 'old', root_id: 'r1', create_at: 1 }),
							post({ id: 'new', root_id: 'r1' })
						);
					return list(
						post({ id: 'top', edit_at: 1_790_000_009_000 }),
						post({ id: 'reply', root_id: 'r1' }),
						post({ id: 'mine', user_id: 'bot' }),
						post({ id: 'old', create_at: 1 })
					);
				})
			)
		);
		const since = new Date(1_789_000_000_000).toISOString();
		const thread = await connection.history!('c1:r1', since);
		expect(thread).toMatchObject({ complete: true, messages: [{ id: 'new', thread: 'c1:r1' }] });
		const channel = await connection.history!('c1', since);
		expect(channel.complete).toBe(true);
		expect(channel.messages).toMatchObject([
			{ id: 'top', group: true, version: new Date(1_790_000_009_000).toISOString() }
		]);
		expect(new URL(urls.at(-1) ?? '').searchParams.get('per_page')).toBe('200');
		await connection.close!();
	});
});
