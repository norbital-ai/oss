// Google Chat: its real client and auth library over the host's fetch, with tokens signed by a key this test holds, in
// the two shapes Google signs them: by Chat's own account for a project number, or as an ID token for a URL.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { gchat } from '../../src/chat/gchat/index.ts';
import { required, host, HOOK } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const google = generateKeyPairSync('rsa', { modulusLength: 2048 }),
	stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = google.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const CHAT = 'chat@system.gserviceaccount.com';
const settings = {
	credentials: JSON.stringify({
		client_email: 'bot@acme.iam.gserviceaccount.com',
		private_key: google.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
	}),
	projectNumber: '123456'
};
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (claims: object, key = google.privateKey) => {
	const now = Math.floor(Date.now() / 1000);
	const payload = `${part({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${part({ iat: now, exp: now + 600, ...claims })}`;
	return `${payload}.${createSign('RSA-SHA256').update(payload).sign(key, 'base64url')}`;
};
const chatToken = (claims: object = {}, key = google.privateKey) => ({
	authorization: `Bearer ${jwt({ iss: CHAT, aud: '123456', ...claims }, key)}`
});
const answer = ({ url }: Call) => {
	if (url.endsWith('/token'))
		return json({ access_token: 'a-1', expires_in: 3600, token_type: 'Bearer' });
	if (url.includes('/x509/')) return json({ k1: pem });
	if (url.includes('/oauth2/v1/certs')) return json({ k1: pem });
	if (url.includes('/media/')) return new Response(new Uint8Array([9]));
	if (url.includes(':findDirectMessage')) return json({ name: 'spaces/DM1' });
	if (url.includes('/messages')) return json({ name: 'spaces/AAA/messages/out1' });
	return json({});
};
const message = (extra: object = {}) => ({
	name: 'spaces/AAA/messages/m1',
	text: '@Acme hello',
	argumentText: ' hello',
	createTime: '2026-11-05T10:00:00.000Z',
	sender: { name: 'users/1', displayName: 'Ann', type: 'HUMAN' },
	thread: { name: 'spaces/AAA/threads/t1' },
	...extra
});
const space = { name: 'spaces/AAA', type: 'ROOM', spaceType: 'SPACE', displayName: 'Town' };
const addOnEvent = (extra: object = {}, inSpace: object = space) =>
	JSON.stringify({ chat: { messagePayload: { message: message(extra), space: inSpace } } });

describe('Google Chat', () => {
	it.live('stores a project-number delivery with exact fields', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gchat, settings),
				body = addOnEvent({
					attachment: [
						{
							contentName: 'a.png',
							contentType: 'image/png',
							attachmentDataRef: { resourceName: 'res1' }
						},
						{ contentName: 'drive.doc', contentType: 'text/plain' }
					],
					quotedMessageMetadata: { name: 'spaces/AAA/messages/m0' }
				});
			expect(h.status).toMatchObject({
				state: 'connected',
				account: 'bot@acme.iam.gserviceaccount.com'
			});
			expect((yield* required(h.link.webhook)(webhook(body, chatToken()))).status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				bins: [new Uint8Array([9])],
				messages: [
					{
						id: 'spaces/AAA/messages/m1',
						thread: 'spaces/AAA/threads/t1',
						sent_at: '2026-11-05T10:00:00.000Z',
						from: { handle: 'users/1', name: 'Ann' },
						text: 'hello',
						group: true,
						title: 'Town',
						reply_to: 'spaces/AAA/messages/m0',
						invocation: 'mention',
						attachments: [
							{ name: 'a.png', mime: 'image/png', bin: 0 },
							{ name: 'drive.doc', mime: 'text/plain' }
						]
					}
				]
			});
		})
	);
	it.live('reads the classic event shape, a direct message, and skips a bot', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gchat, settings);
			const classic = JSON.stringify({
				type: 'MESSAGE',
				message: message({ argumentText: undefined, text: 'plain' }),
				space: { name: 'spaces/DM1', type: 'DM' }
			});
			const bot = addOnEvent({ sender: { name: 'users/9', type: 'BOT' } });
			const added = JSON.stringify({ type: 'ADDED_TO_SPACE', space });
			for (const body of [classic, bot, added])
				expect((yield* required(h.link.webhook)(webhook(body, chatToken()))).status).toBe(200);
			expect(h.events.length).toBe(1);
			expect(h.events[0]).toMatchObject({
				messages: [{ thread: 'spaces/DM1', group: false, text: 'plain', invocation: 'direct' }]
			});
		})
	);
	it.live('accepts an ID token for this endpoint from Chat or this project add-on', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gchat, settings),
				body = addOnEvent();
			const idToken = (email: string, aud = HOOK) => ({
				authorization: `Bearer ${jwt({
					iss: 'https://accounts.google.com',
					aud,
					email,
					email_verified: true
				})}`
			});
			const add = 'service-123456@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';
			expect((yield* required(h.link.webhook)(webhook(body, idToken(CHAT)))).status).toBe(200);
			expect((yield* required(h.link.webhook)(webhook(body, idToken(add)))).status).toBe(200);
			const other = 'service-999@gcp-sa-gsuiteaddons.iam.gserviceaccount.com';
			expect((yield* required(h.link.webhook)(webhook(body, idToken(other)))).status).toBe(401);
			expect(
				(yield* required(h.link.webhook)(webhook(body, idToken(CHAT, 'https://other.test')))).status
			).toBe(401);
			expect(h.events.length).toBe(2);
		})
	);
	it.live('refuses a forged signature, another project, and no token, storing nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gchat, settings),
				body = addOnEvent();
			const forged = chatToken({}, stranger.privateKey);
			expect((yield* required(h.link.webhook)(webhook(body, forged))).status).toBe(401);
			const otherProject = chatToken({ aud: '999' });
			expect((yield* required(h.link.webhook)(webhook(body, otherProject))).status).toBe(401);
			expect((yield* required(h.link.webhook)(webhook(body, {}))).status).toBe(401);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			const h = yield* connected(gchat, settings, {
					emit: () => Promise.reject(new Error('the store refused'))
				}),
				body = addOnEvent();
			expect((yield* required(h.link.webhook)(webhook(body, chatToken()))).status).toBe(500);
		})
	);
	it.live('sends with a request id, into a thread, and finds a direct space', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(gchat, settings);
			const sent = yield* required(h.link.send)(
				{ id: 'r1', to: 'spaces/AAA/threads/t1', text: 'Hello' },
				[]
			);
			expect(sent).toMatchObject({ provider_id: 'spaces/AAA/messages/out1' });
			const call = api.calls.at(-1);
			const url = new URL(call?.url ?? '');
			expect(url.pathname).toBe('/v1/spaces/AAA/messages');
			expect(url.searchParams.get('requestId')).toMatch(/^[0-9a-f]{64}$/);
			expect(url.searchParams.get('messageReplyOption')).toBe(
				'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
			);
			expect(call?.headers.get('authorization')).toBe('Bearer a-1');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				text: 'Hello',
				thread: { name: 'spaces/AAA/threads/t1' }
			});
			yield* required(h.link.send)({ id: 'r1', to: 'spaces/AAA/threads/t1', text: 'Hello' }, []);
			expect(new URL(api.calls.at(-1)?.url ?? '').searchParams.get('requestId')).toBe(
				url.searchParams.get('requestId')
			);
			yield* required(h.link.test)({ to: 'users/1' });
			expect(new URL(api.calls.at(-2)?.url ?? '').searchParams.get('name')).toBe('users/1');
			expect(new URL(api.calls.at(-1)?.url ?? '').pathname).toBe('/v1/spaces/DM1/messages');
		})
	);
	it.live('a service account Google refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: 'invalid_grant' }, 400));
			const h = yield* host(chatProvider(gchat), fetch);
			yield* Effect.flip(required(h.link.pair)(settings));
			yield* Effect.flip(required(h.link.pair)({ ...settings, credentials: 'not json' }));
			expect(h.values.size).toBe(0);
		})
	);
	it.live('history reads a thread from a time, deletes included', () =>
		Effect.gen(function* () {
			const pages = [
				{
					messages: [
						message(),
						message({ name: 'spaces/AAA/messages/m2', deleteTime: '2026-11-05T11:00:00.000Z' }),
						message({ name: 'spaces/AAA/messages/m3', sender: { name: 'users/9', type: 'BOT' } })
					],
					nextPageToken: 'next'
				},
				{ messages: [message({ name: 'spaces/AAA/messages/m4' })] }
			];
			const api = yield* platformApi((call) =>
				call.url.includes('/messages?') ? json(pages.shift() ?? {}) : answer(call)
			);
			const connection = yield* Effect.promise(() =>
				gchat.connect(settings, { fetch, webhook_url: HOOK, receive: () => Promise.resolve() })
			);
			const read = yield* Effect.promise(() =>
				required(connection.history)('spaces/AAA/threads/t1', '2026-11-05T00:00:00.000Z')
			);
			expect(read.complete).toBe(true);
			expect(read.messages).toMatchObject([
				{ id: 'spaces/AAA/messages/m1', thread: 'spaces/AAA/threads/t1', group: true },
				{ id: 'spaces/AAA/messages/m2', deleted: true, text: '' },
				{ id: 'spaces/AAA/messages/m4' }
			]);
			const url = new URL(api.calls.at(-1)?.url ?? '');
			expect(url.pathname).toBe('/v1/spaces/AAA/messages');
			expect(url.searchParams.get('pageToken')).toBe('next');
			expect(url.searchParams.get('showDeleted')).toBe('true');
			expect(url.searchParams.get('filter')).toBe(
				'create_time > "2026-11-05T00:00:00.000Z" AND thread.name = spaces/AAA/threads/t1'
			);
		})
	);
	it.live('history without an administrator approval is an incomplete nothing', () =>
		Effect.gen(function* () {
			yield* platformApi((call) =>
				call.url.includes('/messages?') ? json({ error: { code: 403 } }, 403) : answer(call)
			);
			const connection = yield* Effect.promise(() =>
				gchat.connect(settings, { fetch, webhook_url: HOOK, receive: () => Promise.resolve() })
			);
			const read = yield* Effect.promise(() => required(connection.history)('spaces/DM1', 'x'));
			expect(read).toEqual({ messages: [], complete: false });
		})
	);
});
