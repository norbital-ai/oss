// Gmail: JWTs signed as Google signs a Pub/Sub push, and its REST API and token endpoint faked behind `fetch`.
// `chatProvider` does not run `changes` yet, so the change log is driven through the connection itself.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import PostalMime from 'postal-mime';
import { vi } from 'vitest';
import { chatProvider } from '../../src/chat/adapter.ts';
import { gmail } from '../../src/chat/gmail/index.ts';
import { HOOK, host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const settings = {
	clientId: 'client',
	clientSecret: 'secret',
	refreshToken: 'refresh',
	topicName: 'projects/acme/topics/gmail',
	pushAccount: 'push@acme.iam.gserviceaccount.com'
};
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const google = generateKeyPairSync('rsa', { modulusLength: 2048 });
const forger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: object = {}, key = google.privateKey) => {
	const now = Math.floor(Date.now() / 1000),
		head = `${part({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${part({
			iss: 'https://accounts.google.com',
			aud: HOOK,
			iat: now,
			exp: now + 3600,
			sub: '1',
			email: settings.pushAccount,
			email_verified: true,
			...claims
		})}`;
	return `${head}.${createSign('RSA-SHA256').update(head).sign(key, 'base64url')}`;
};
const push = (token: string) =>
	webhook(
		JSON.stringify({
			subscription: 'projects/acme/subscriptions/gmail',
			message: {
				messageId: 'p1',
				data: Buffer.from(
					JSON.stringify({ emailAddress: 'desk@acme.test', historyId: 200 })
				).toString('base64')
			}
		}),
		{ authorization: `Bearer ${token}` }
	);

const mail = (headers: string, body = 'Hello there') =>
	Buffer.from(`${headers}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`).toString(
		'base64url'
	);
const stored = (id: string, raw: string, labelIds = ['INBOX']) =>
	json({ id, threadId: 't1', internalDate: '1790000000000', labelIds, raw });
const m1 = mail(
	'From: "Ada Lovelace" <Ada@example.com>\r\nTo: desk@acme.test\r\nSubject: Invoice\r\nMessage-ID: <m1@example.com>'
);
const threadedReply = mail(
	'From: Ada <ada@example.com>\r\nReply-To: billing@example.com\r\nTo: desk@acme.test\r\nCc: bob@example.com\r\nSubject: Invoice\r\nMessage-ID: <m2@example.com>\r\nIn-Reply-To: <m1@example.com>\r\nReferences: <m0@example.com> <m1@example.com>'
);
const htmlOnly = Buffer.from(
	'From: ada@example.com\r\nTo: desk@acme.test\r\nContent-Type: text/html\r\n\r\n<p>Hi <b>there</b></p>\r\n'
).toString('base64url');
const withFile = Buffer.from(
	[
		'From: ada@example.com',
		'To: desk@acme.test',
		'Subject: Report',
		'Content-Type: multipart/mixed; boundary=b',
		'',
		'--b',
		'Content-Type: text/plain',
		'',
		'See attached',
		'--b',
		'Content-Type: text/csv; name=a.csv',
		'Content-Disposition: attachment; filename=a.csv',
		'Content-Transfer-Encoding: base64',
		'',
		Buffer.from('a,b').toString('base64'),
		'--b--',
		''
	].join('\r\n')
).toString('base64url');

/** The mailbox: history pages by page token, and messages by id. */
const answer =
	(
		history: (query: URLSearchParams) => Response = () => json({ historyId: '150' }),
		messages: Record<string, () => Response> = {}
	) =>
	(call: Call) => {
		const url = new URL(call.url);
		if (call.url === 'https://oauth2.googleapis.com/token')
			return json({ access_token: 'access', expires_in: 3600, token_type: 'Bearer' });
		if (call.url === 'https://www.googleapis.com/oauth2/v1/certs')
			return json({ k1: google.publicKey.export({ type: 'spki', format: 'pem' }) });
		if (call.url === `${API}/profile`)
			return json({ emailAddress: 'Desk@acme.test', historyId: '100' });
		if (call.url === `${API}/watch`) return json({ historyId: '100', expiration: '1790000000000' });
		if (url.pathname.endsWith('/history')) return history(url.searchParams);
		if (url.pathname.endsWith('/messages/send')) return json({ id: 'out1', threadId: 't1' });
		if (url.pathname.endsWith('/threads/t1'))
			return json({ id: 't1', messages: [{ id: 'm2' }, { id: 'out0' }] });
		const id = url.pathname.split('/').at(-1) ?? '';
		return messages[id]?.() ?? json({ error: { code: 404 } }, 404);
	};
const open = () =>
	Effect.acquireRelease(
		Effect.promise(() =>
			gmail.connect(settings, {
				fetch,
				webhookUrl: HOOK,
				receive: () => Promise.resolve()
			})
		),
		(connection) => Effect.promise(async () => connection.close?.())
	);
const changes = (connection: Effect.Success<ReturnType<typeof open>>, cursor: string | null) =>
	Effect.promise(async () => (await connection.changes?.(cursor)) ?? { messages: [], cursor: '' });

describe('Gmail', () => {
	it.live('a push signed by Google is acknowledged and carries nothing to store', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(gmail, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'desk@acme.test' });
			expect((yield* h.link.webhook!(push(jwt()))).status).toBe(200);
			expect(h.events).toEqual([]);
			yield* h.link.close!;
		})
	);
	it.live('refuses a push whose token is forged, misaddressed or missing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const h = yield* connected(gmail, settings);
			const refused = [
				push(jwt({}, forger.privateKey)),
				push(jwt({ aud: 'https://elsewhere.test/' })),
				push(jwt({ email: 'other@acme.iam.gserviceaccount.com' })),
				push(jwt({ email_verified: false })),
				push(jwt({ iss: 'https://evil.test' })),
				webhook('{}', {})
			];
			for (const request of refused) expect((yield* h.link.webhook!(request)).status).toBe(401);
			expect(h.events).toEqual([]);
			yield* h.link.close!;
		})
	);
	it.live('null asks for a starting cursor, and Gmail names it', () =>
		Effect.gen(function* () {
			yield* platformApi(answer());
			const connection = yield* open();
			expect(gmail.consistency).toBe('changes');
			expect(connection.history).toBeUndefined();
			expect(yield* changes(connection, null)).toEqual({ messages: [], cursor: '100' });
		})
	);
	it.live('reads every page from the cursor, with exact fields and real deletes', () =>
		Effect.gen(function* () {
			const seen: URLSearchParams[] = [];
			yield* platformApi(
				answer(
					(query) => {
						seen.push(query);
						return query.get('pageToken') === null
							? json({
									history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
									historyId: '180',
									nextPageToken: 'next'
								})
							: json({
									history: [
										{ messagesAdded: [{ message: { id: 'm2', threadId: 't1' } }] },
										{ messagesDeleted: [{ message: { id: 'old', threadId: 't0' } }] }
									],
									historyId: '200'
								});
					},
					{ m1: () => stored('m1', m1), m2: () => stored('m2', threadedReply) }
				)
			);
			const connection = yield* open();
			const answered = yield* changes(connection, '100');
			expect(seen.map((query) => query.get('startHistoryId'))).toEqual(['100', '100']);
			expect(seen[0]?.getAll('historyTypes')).toEqual(['messageAdded', 'messageDeleted']);
			expect(answered.cursor).toBe('200');
			expect(answered.messages).toMatchObject([
				{
					id: 'm1',
					thread: 't1',
					sentAt: new Date(1_790_000_000_000).toISOString(),
					from: { handle: 'ada@example.com', name: 'Ada Lovelace' },
					text: 'Hello there',
					group: false,
					mentioned: true,
					replyTo: null,
					title: 'Invoice',
					files: []
				},
				{ id: 'm2', group: true, mentioned: true, replyTo: '<m1@example.com>' },
				{ id: 'old', thread: '', deleted: true }
			]);
		})
	);
	it.live('holds no cursor: a store that failed reads the same changes again', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answer(
					() =>
						json({
							history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
							historyId: '200'
						}),
					{ m1: () => stored('m1', m1) }
				)
			);
			const connection = yield* open();
			expect(yield* changes(connection, '100')).toEqual(yield* changes(connection, '100'));
		})
	);
	it.live('an expired cursor starts again from a fresh one', () =>
		Effect.gen(function* () {
			yield* platformApi(answer(() => json({ error: { code: 404 } }, 404)));
			const connection = yield* open();
			expect(yield* changes(connection, '1')).toEqual({ messages: [], cursor: '100' });
		})
	);
	it.live('skips its own mail, mail outside the inbox, and mail gone before it was read', () =>
		Effect.gen(function* () {
			const ids = ['sent', 'spam', 'vanished', 'both'];
			yield* platformApi(
				answer(
					() =>
						json({
							history: [
								{ messagesAdded: ids.map((id) => ({ message: { id, threadId: 't1' } })) },
								{ messagesDeleted: [{ message: { id: 'both', threadId: 't1' } }] }
							],
							historyId: '200'
						}),
					{
						sent: () => stored('sent', m1, ['SENT', 'INBOX']),
						spam: () => stored('spam', m1, ['SPAM']),
						both: () => stored('both', m1)
					}
				)
			);
			const connection = yield* open();
			const { messages } = yield* changes(connection, '100');
			expect(messages).toMatchObject([{ id: 'both', deleted: true }]);
			expect(messages).toHaveLength(1);
		})
	);
	it.live('an HTML mail reads as its text', () =>
		Effect.gen(function* () {
			yield* platformApi(
				answer(
					() =>
						json({
							history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
							historyId: '200'
						}),
					{ m1: () => stored('m1', htmlOnly) }
				)
			);
			const connection = yield* open();
			const { messages } = yield* changes(connection, '100');
			expect(messages[0]?.text).toBe('Hi there');
		})
	);
	it.live('an attachment is read when it is asked for', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(
				answer(
					() =>
						json({
							history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
							historyId: '200'
						}),
					{ m1: () => stored('m1', withFile) }
				)
			);
			const connection = yield* open();
			const { messages } = yield* changes(connection, '100');
			const reads = () => api.calls.filter((call) => call.url.includes('/messages/m1')).length;
			expect(reads()).toBe(1);
			const [file] = messages[0]?.files ?? [];
			expect(file).toMatchObject({ name: 'a.csv', mime: 'text/csv' });
			const bytes = yield* Effect.promise(async () => file?.fetch?.());
			expect(Buffer.from(bytes ?? []).toString()).toBe('a,b');
			expect(reads()).toBe(2);
		})
	);
	it.live('answers in the thread, to Reply-To, on the last mail that is not its own', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(
				answer(undefined, {
					m2: () => stored('m2', threadedReply),
					out0: () => stored('out0', m1, ['SENT'])
				})
			);
			const h = yield* connected(gmail, settings);
			const file = {
				id: 'f1',
				name: 'a.txt',
				mime: 'text/plain',
				bytes: new TextEncoder().encode('receipt'),
				url: () => Promise.reject(new Error('no link'))
			};
			expect(yield* h.link.send!({ id: 'r1', to: 't1', text: 'Paid' }, [file])).toMatchObject({
				providerId: 'out1'
			});
			const call = api.calls.at(-1);
			expect(call?.url).toBe(`${API}/messages/send`);
			expect(call?.headers.get('authorization')).toBe('Bearer access');
			const body = JSON.parse(call?.body ?? '') as { raw: string; threadId?: string };
			expect(body.threadId).toBe('t1');
			const sent = yield* Effect.promise(() =>
				PostalMime.parse(Buffer.from(body.raw, 'base64url'))
			);
			expect(sent).toMatchObject({
				subject: 'Invoice',
				inReplyTo: '<m2@example.com>',
				to: [{ address: 'billing@example.com' }],
				from: { address: 'desk@acme.test' }
			});
			expect(sent.references).toBe('<m0@example.com> <m1@example.com> <m2@example.com>');
			expect(sent.text?.trim()).toBe('Paid');
			expect(sent.attachments).toMatchObject([{ filename: 'a.txt', mimeType: 'text/plain' }]);
			yield* h.link.close!;
		})
	);
	it.live('a thread that is an address starts a new mail', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer());
			const h = yield* connected(gmail, settings);
			yield* h.link.test!({ to: 'ada@example.com' });
			const body = JSON.parse(api.calls.at(-1)?.body ?? '') as { raw: string; threadId?: string };
			expect(body.threadId).toBeUndefined();
			const sent = yield* Effect.promise(() =>
				PostalMime.parse(Buffer.from(body.raw, 'base64url'))
			);
			expect(sent).toMatchObject({
				subject: 'Norbital test message',
				to: [{ address: 'ada@example.com' }]
			});
			yield* h.link.close!;
		})
	);
	it.live('a refresh token Google refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.endsWith('/token')
					? json({ error: 'invalid_grant', error_description: 'Bad Request' }, 400)
					: answer()(call)
			);
			const h = yield* host(chatProvider(gmail), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('a topic Gmail cannot publish to keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.endsWith('/watch') ? json({ error: { code: 403 } }, 403) : answer()(call)
			);
			const h = yield* host(chatProvider(gmail), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('renews its watch every day until it closes', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer());
			vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
			yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
			const connection = yield* Effect.promise(() =>
				gmail.connect(settings, { fetch, webhookUrl: HOOK, receive: () => Promise.resolve() })
			);
			const watches = () => api.calls.filter((call) => call.url.endsWith('/watch')).length;
			expect(watches()).toBe(1);
			yield* Effect.promise(() => vi.advanceTimersByTimeAsync(86_400_000));
			yield* Effect.promise(() => new Promise((done) => setImmediate(done)));
			expect(watches()).toBe(2);
			yield* Effect.promise(async () => connection.close?.());
			expect(vi.getTimerCount()).toBe(0);
		})
	);
});
