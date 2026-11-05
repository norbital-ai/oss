// Photon: deliveries signed as Spectrum Cloud signs them. Its gRPC cannot go through `fetch`, so the seam is the platform
// definition's `lifecycle.createClient`; the last tests leave that real, with only the token endpoint faked.
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from '@effect/vitest';
import { imessage } from '@spectrum-ts/imessage';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { photon } from '../../src/chat/photon/index.ts';
import { host, until } from '../kit.ts';
import { connected, json, platformApi, webhook } from './kit.ts';

const settings = { projectId: 'p1', projectSecret: 'secret', webhookSecret: 'hook' },
	person = '+15551234567',
	direct = `any;-;${person}`,
	group = 'iMessage;+;chat1',
	at = '2026-01-02T03:04:05.000Z';
const { lifecycle } = imessage.config().__definition;

/** An SDK stream: `close` ends an iteration quietly, as `TypedEventStream` does. */
const stream = <A>(events: readonly A[], hang = false) => {
	let release = () => {};
	const closed = new Promise<void>((resolve) => {
		release = resolve;
	});
	const source = (async function* () {
		yield* events;
		if (hang) await closed;
	})();
	return Object.assign(source, { close: vi.fn(async () => release()) });
};
const complete = (headSequence: number) => ({ type: 'catchup.complete', headSequence });
const line = (phone = 'shared') => ({
	phone,
	client: {
		messages: {
			sendText: vi.fn(async (): Promise<unknown> => ({ guid: 'out1' })),
			get: vi.fn(async () => ({ isFromMe: true }))
		},
		chats: {
			setTyping: vi.fn(async () => {}),
			create: vi.fn(async () => ({ chat: { guid: `iMessage;-;${person}` } }))
		},
		attachments: {
			downloadStream: vi.fn(() =>
				stream([
					{ type: 'header' },
					{ type: 'primaryChunk', data: new Uint8Array([1, 2]) },
					{ type: 'companionChunk', data: new Uint8Array([9]) },
					{ type: 'primaryChunk', data: new Uint8Array([3]) }
				])
			)
		},
		events: { catchUp: vi.fn((_since?: number): unknown => stream([complete(7)])) },
		close: vi.fn(async () => {})
	}
});
const seam = (...lines: readonly ReturnType<typeof line>[]) =>
	vi.spyOn(lifecycle, 'createClient').mockResolvedValue(lines);
const open = () =>
	Effect.promise(() =>
		photon.connect(settings, {
			fetch,
			webhookUrl: 'https://hook.test/',
			receive: () => Promise.resolve()
		})
	);
const delivery = (message: object = {}) =>
	JSON.stringify({
		event: 'messages',
		space: { id: direct, type: 'dm', phone: 'shared' },
		message: {
			id: 'guid1',
			platform: 'iMessage',
			direction: 'inbound',
			timestamp: at,
			sender: { id: person },
			space: { id: direct, type: 'dm', phone: 'shared' },
			content: { type: 'text', text: 'Hello' },
			...message
		}
	});
/** `v0=<hex HMAC-SHA256 of "v0:timestamp:body">`, the timestamp in its own header. */
const sign = (body: string, secret = 'hook', seconds = Math.floor(Date.now() / 1000)) => ({
	'x-spectrum-timestamp': String(seconds),
	'x-spectrum-signature': `v0=${createHmac('sha256', secret).update(`v0:${seconds}:${body}`).digest('hex')}`
});
const received = (guid: string, chatGuid = direct, extra: object = {}) => ({
	type: 'message.received',
	sequence: 1,
	chatGuid,
	isFromMe: false,
	occurredAt: new Date(at),
	message: {
		guid,
		isFromMe: false,
		itemType: 'normal',
		dateCreated: new Date('2026-01-02T03:04:04.000Z'),
		sender: { address: person },
		content: { text: 'Hello', attachments: [], mentions: [], formatting: [] },
		...extra
	}
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Photon', () => {
	it.live('stores a signed message before acknowledging it', () =>
		Effect.gen(function* () {
			seam(line());
			const h = yield* connected(photon, settings),
				body = delivery();
			expect(h.status).toMatchObject({ state: 'connected', account: 'p1' });
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'guid1',
						thread: direct,
						sentAt: at,
						text: 'Hello',
						from: { handle: person, name: null },
						replyTo: null,
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live('refuses a bad or a stale signature and stores nothing', () =>
		Effect.gen(function* () {
			seam(line());
			const h = yield* connected(photon, settings),
				body = delivery();
			const stale = sign(body, 'hook', Math.floor(Date.now() / 1000) - 301);
			for (const headers of [sign(body, 'forged'), stale, {}])
				expect((yield* h.link.webhook!(webhook(body, headers))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			seam(line());
			const h = yield* connected(photon, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = delivery();
			expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(500);
		})
	);
	it.live('stores neither its own, a reaction, a rename, another platform nor another event', () =>
		Effect.gen(function* () {
			seam(line());
			const h = yield* connected(photon, settings);
			for (const body of [
				delivery({ direction: 'outbound' }),
				delivery({ content: { type: 'reaction', emoji: '👍', target: { id: 'guid0' } } }),
				delivery({ content: { type: 'rename', displayName: 'Crew' } }),
				delivery({ platform: 'WhatsApp' }),
				JSON.stringify({ ...JSON.parse(delivery()), event: 'other' })
			])
				expect((yield* h.link.webhook!(webhook(body, sign(body)))).status).toBe(200);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a group reply to our message invokes; any other group message is ambient', () =>
		Effect.gen(function* () {
			const remote = line();
			seam(remote);
			const h = yield* connected(photon, settings),
				space = { id: group, type: 'group', phone: 'shared' };
			const reply = delivery({
				space,
				content: {
					type: 'reply',
					target: { id: 'p:0/guid0' },
					content: { type: 'text', text: 'Sure' }
				}
			});
			const ambient = delivery({ id: 'guid2', space });
			yield* h.link.webhook!(webhook(reply, sign(reply)));
			yield* h.link.webhook!(webhook(ambient, sign(ambient)));
			expect(h.events[0]).toMatchObject({
				messages: [
					{ thread: group, group: true, text: 'Sure', replyTo: 'guid0', invocation: 'reply' }
				]
			});
			expect(remote.client.messages.get).toHaveBeenCalledWith('guid0');
			expect(h.events[1]).toMatchObject({ messages: [{ invocation: 'ambient' }] });
		})
	);
	it.live('joins a multi-part message and reads its file over the stream', () =>
		Effect.gen(function* () {
			const remote = line();
			seam(remote);
			const h = yield* connected(photon, settings);
			const body = delivery({
				content: {
					type: 'group',
					items: [
						{ content: { type: 'text', text: 'Look' } },
						{ content: { type: 'richlink', url: 'https://a.test/' } },
						{
							content: {
								type: 'attachment',
								id: 'att1',
								name: 'a.png',
								mimeType: 'image/png',
								size: 3
							}
						}
					]
				}
			});
			yield* h.link.webhook!(webhook(body, sign(body)));
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1, 2, 3])],
				messages: [
					{
						text: 'Look\nhttps://a.test/',
						attachments: [{ name: 'a.png', mime: 'image/png', bytes: 3, bin: 0 }]
					}
				]
			});
			expect(remote.client.attachments.downloadStream).toHaveBeenCalledWith('att1');
		})
	);
	it.live('sends with a client message id, so a resend cannot duplicate', () =>
		Effect.gen(function* () {
			const remote = line();
			seam(remote);
			const h = yield* connected(photon, settings);
			const sent = yield* h.link.send!({ id: 'r1', to: direct, text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: 'out1' });
			expect(remote.client.messages.sendText).toHaveBeenCalledWith(direct, 'Hello', {
				clientMessageId: 'r1'
			});
			const connection = yield* open();
			const answered = yield* Effect.promise(() => connection.send(direct, 'Hello', 'r1', []));
			expect(answered).toEqual({ id: 'out1', idempotent: true });
		})
	);
	it.live('a send the SDK calls final fails for good; any other retries', () =>
		Effect.gen(function* () {
			const remote = line();
			seam(remote);
			const h = yield* connected(photon, settings);
			remote.client.messages.sendText.mockRejectedValueOnce(
				Object.assign(new Error('no such chat'), { retryable: false })
			);
			const refused = yield* Effect.flip(h.link.send!({ to: direct, text: 'Hello' }, []));
			expect(refused).toMatchObject({ _tag: 'ProviderRefused', permanent: true });
			remote.client.messages.sendText.mockRejectedValueOnce(
				Object.assign(new Error('unreachable'), { retryable: true })
			);
			const down = yield* Effect.flip(h.link.send!({ to: direct, text: 'Hello' }, []));
			expect(down).toMatchObject({ _tag: 'ProviderUnavailable' });
		})
	);
	it.live('sets typing, and opens a person on a shared line without a call', () =>
		Effect.gen(function* () {
			const remote = line();
			seam(remote);
			const connection = yield* open();
			yield* Effect.promise(async () => {
				await connection.typing?.(direct, true);
				await connection.typing?.(direct, false);
			});
			expect(remote.client.chats.setTyping.mock.calls).toEqual([
				[direct, true],
				[direct, false]
			]);
			const thread = yield* Effect.promise(async () => connection.openDirect?.(person));
			expect(thread).toBe(direct);
			expect(remote.client.chats.create).not.toHaveBeenCalled();
		})
	);
	it.live('with several lines a thread names its line, and every call follows it', () =>
		Effect.gen(function* () {
			const one = line('+16290000001'),
				two = line('+16290000002');
			seam(one, two);
			const h = yield* connected(photon, settings);
			expect(h.status).toMatchObject({ account: '+16290000001' });
			const space = { id: direct, phone: '+16290000002' },
				body = delivery({ space }),
				thread = `${direct}~+16290000002`;
			yield* h.link.webhook!(webhook(body, sign(body)));
			expect(h.events[0]).toMatchObject({ messages: [{ thread }] });
			yield* h.link.send!({ to: thread, text: 'Hello' }, []);
			expect(two.client.messages.sendText).toHaveBeenCalledWith(direct, 'Hello', expect.anything());
			expect(one.client.messages.sendText).not.toHaveBeenCalled();
			const connection = yield* open();
			const opened = yield* Effect.promise(async () => connection.openDirect?.(person));
			expect(opened).toBe(`iMessage;-;${person}~+16290000001`);
			expect(one.client.chats.create).toHaveBeenCalledWith([person]);
		})
	);
	it.live('a starting cursor replays nothing into the store', () =>
		Effect.gen(function* () {
			const remote = line();
			remote.client.events.catchUp.mockImplementation(() => stream([received('old'), complete(7)]));
			seam(remote);
			const connection = yield* open();
			const answer = yield* Effect.promise(async () => connection.changes?.(null));
			expect(answer).toEqual({ messages: [], cursor: '{"shared":7}' });
			expect(remote.client.events.catchUp).toHaveBeenCalledWith(undefined);
		})
	);
	it.live('the log gives what a webhook missed, edits and unsends, and none of its own', () =>
		Effect.gen(function* () {
			const remote = line(),
				edited = new Date('2026-01-03T00:00:00.000Z'),
				unsent = new Date('2026-01-04T00:00:00.000Z'),
				context = { chatGuid: group, isFromMe: false, actor: { address: person } };
			remote.client.events.catchUp.mockImplementation(() =>
				stream([
					received('m1', group, {
						groupTitle: 'Crew',
						replyTargetGuid: 'm0',
						content: {
							text: '￼Look',
							mentions: [],
							attachments: [
								{ guid: 'att1', fileName: 'a.png', mimeType: 'image/png', totalBytes: 3 }
							]
						}
					}),
					received('mine', direct, { isFromMe: true }),
					received('tap', direct, { reaction: { kind: 'love' } }),
					received('rename', group, { itemType: 'groupNameChange' }),
					{
						...context,
						type: 'message.edited',
						messageGuid: 'm2',
						content: { text: 'Fixed' },
						editedAt: edited
					},
					{ ...context, type: 'message.unsent', messageGuid: 'm3', retractedAt: unsent },
					{
						...context,
						isFromMe: true,
						type: 'message.unsent',
						messageGuid: 'm4',
						retractedAt: unsent
					},
					{ ...context, type: 'message.read', messageGuid: 'm2', readAt: unsent },
					{ ...context, type: 'chat.markedRead' },
					complete(12)
				])
			);
			seam(remote);
			const connection = yield* open();
			const answer = yield* Effect.promise(async () => connection.changes?.('{"shared":7}'));
			expect(remote.client.events.catchUp).toHaveBeenCalledWith(7);
			expect(answer?.cursor).toBe('{"shared":12}');
			expect(answer?.gap).toBeUndefined();
			expect(answer?.messages).toMatchObject([
				{
					id: 'm1',
					thread: group,
					sentAt: at,
					group: true,
					title: 'Crew',
					text: 'Look',
					replyTo: 'm0',
					files: [{ name: 'a.png', mime: 'image/png', bytes: 3 }]
				},
				{
					id: 'm2',
					thread: group,
					text: 'Fixed',
					version: edited.toISOString(),
					from: { handle: person }
				},
				{ id: 'm3', thread: group, deleted: true, sentAt: unsent.toISOString() }
			]);
			expect(answer?.messages).toHaveLength(3);
		})
	);
	it.live('a mention of its own line is a mention', () =>
		Effect.gen(function* () {
			const remote = line('+16290000001');
			remote.client.events.catchUp.mockImplementation(() =>
				stream([
					received('m1', group, {
						content: {
							text: '@bot hi',
							attachments: [],
							mentions: [{ address: '+16290000001', start: 0, length: 4 }]
						}
					}),
					complete(8)
				])
			);
			seam(remote);
			const connection = yield* open();
			const answer = yield* Effect.promise(async () => connection.changes?.('{"+16290000001":7}'));
			expect(answer?.messages).toMatchObject([{ mentioned: true }]);
		})
	);
	it.live('a lost cursor restarts and says what it lost', () =>
		Effect.gen(function* () {
			const remote = line();
			remote.client.events.catchUp.mockImplementation((since) => {
				if (since === undefined) return stream([received('old'), complete(30)]);
				const failing = stream<never>([]);
				return Object.assign(
					(async function* () {
						yield* [];
						throw Object.assign(new Error('expired'), { grpcCode: 9 });
					})(),
					{ close: failing.close }
				);
			});
			seam(remote);
			const connection = yield* open();
			const answer = yield* Effect.promise(async () => connection.changes?.('{"shared":7}'));
			expect(answer).toEqual({ messages: [], cursor: '{"shared":30}', gap: true });
		})
	);
	it.live('a catch-up cut short keeps no cursor', () =>
		Effect.gen(function* () {
			const remote = line();
			remote.client.events.catchUp.mockImplementation(() => stream([received('m1')]));
			seam(remote);
			const connection = yield* open();
			const failed = yield* Effect.promise(async () =>
				connection.changes?.('{"shared":7}').then(
					() => 'answered',
					(error: Error) => error.message
				)
			);
			expect(failed).toBe('Photon ended its catch-up early');
		})
	);
	it.live('reads the log through the provider, and keeps the cursor it reached', () =>
		Effect.gen(function* () {
			seam(line());
			const h = yield* connected(photon, settings);
			yield* until(() => h.values.has('cursor'));
			expect(h.values.get('cursor')).toBe('{"shared":7}');
		})
	);
	it.live('close ends the streams in flight, their readers fail, and the clients close', () =>
		Effect.gen(function* () {
			const remote = line(),
				replaying = stream([], true),
				downloading = stream([{ type: 'primaryChunk', data: new Uint8Array([1]) }], true);
			remote.client.events.catchUp.mockImplementation(() => replaying);
			remote.client.attachments.downloadStream.mockImplementation(() => downloading);
			seam(remote);
			const connection = yield* open();
			const body = delivery({
				content: { type: 'attachment', id: 'att1', name: 'a.png', mimeType: 'image/png' }
			});
			const { messages } = yield* Effect.promise(() =>
				connection.deliver(webhook(body, sign(body)), body)
			);
			const fetching = messages[0]?.files?.[0]?.fetch?.().then(
				() => 'read',
				(error: Error) => error.message
			);
			const catching = connection.changes?.('{"shared":7}').then(
				() => 'read',
				(error: Error) => error.message
			);
			yield* until(() => remote.client.events.catchUp.mock.calls.length > 0);
			yield* Effect.promise(async () => connection.close?.());
			expect(yield* Effect.promise(async () => fetching)).toBe('Photon closed');
			expect(yield* Effect.promise(async () => catching)).toBe('Photon closed');
			expect(replaying.close).toHaveBeenCalled();
			expect(downloading.close).toHaveBeenCalled();
			expect(remote.client.close).toHaveBeenCalledTimes(1);
		})
	);
	it.live('a project with no line fails pairing and leaves nothing behind', () =>
		Effect.gen(function* () {
			seam();
			const h = yield* host(chatProvider(photon), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('a project Photon refuses keeps nothing', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(() => json({ code: 'unauthorized', message: 'no' }, 401));
			const h = yield* host(chatProvider(photon), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
			const call = api.calls[0];
			expect(call?.url).toMatch(/\/projects\/p1\/imessage\/tokens$/);
			expect(call?.headers.get('authorization')).toBe(`Basic ${btoa('p1:secret')}`);
		})
	);
	it.live('the real clients: no signal hook, and close clears the token timer and channels', () =>
		Effect.gen(function* () {
			yield* platformApi(() =>
				json({ succeed: true, data: { type: 'shared', token: 't', expiresIn: 3600 } })
			);
			const made: { client: { chats: { setTyping(chat: string, on: boolean): Promise<void> } } }[] =
				[];
			const real = lifecycle.createClient;
			vi.spyOn(lifecycle, 'createClient').mockImplementation(async (context) => {
				const lines = await real(context);
				made.push(...lines);
				return lines;
			});
			const timers = vi.spyOn(globalThis, 'setTimeout'),
				cleared = vi.spyOn(globalThis, 'clearTimeout'),
				term = process.listenerCount('SIGTERM'),
				int = process.listenerCount('SIGINT');
			const connection = yield* open();
			expect(process.listenerCount('SIGTERM')).toBe(term);
			expect(process.listenerCount('SIGINT')).toBe(int);
			const renewal = timers.mock.calls.findIndex(([, delay]) => delay === 2_880_000);
			expect(renewal).toBeGreaterThanOrEqual(0);
			const timer = timers.mock.results[renewal]?.value;
			yield* Effect.promise(async () => connection.close?.());
			expect(cleared).toHaveBeenCalledWith(timer);
			const shut = yield* Effect.promise(async () =>
				made[0]?.client.chats.setTyping(direct, true).then(
					() => 'open',
					(error: Error) => error.message
				)
			);
			expect(shut).toMatch(/shut ?down/i);
		})
	);
});
