// Teams: the SDK's real token validator over tokens this test signs, the login and Connector faked behind `fetch`. The
// validator reads Microsoft's signing keys through jwks-rsa, past any `fetch`, so that one key lookup is the seam.
import { createSign, generateKeyPairSync } from 'node:crypto';
import { JwtValidator } from '@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js';
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { chatProvider } from '../../src/chat/adapter.ts';
import { teams } from '../../src/chat/teams/index.ts';
import { host } from '../kit.ts';
import { connected, json, platformApi, webhook, type Call } from './kit.ts';

const microsoft = generateKeyPairSync('rsa', { modulusLength: 2048 }),
	stranger = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SERVICE = 'https://smba.trafficmanager.net/amer/';
const settings = { appId: 'app-1', appPassword: 'secret', appTenantId: 'tenant-1' };
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (claims: object = {}, key = microsoft.privateKey) => {
	const now = Math.floor(Date.now() / 1000);
	const payload = `${part({ alg: 'RS256', typ: 'JWT', kid: 'k1' })}.${part({
		iss: 'https://api.botframework.com',
		aud: 'app-1',
		serviceurl: SERVICE,
		nbf: now - 60,
		exp: now + 600,
		...claims
	})}`;
	return `Bearer ${payload}.${createSign('RSA-SHA256').update(payload).sign(key, 'base64url')}`;
};
/** Microsoft's signing key, as jwks-rsa would have found it. */
const keys = Effect.acquireRelease(
	Effect.sync(() => {
		const real = Object.getOwnPropertyDescriptor(JwtValidator.prototype, 'getSigningKey');
		Object.defineProperty(JwtValidator.prototype, 'getSigningKey', {
			configurable: true,
			value: (_header: object, callback: (error: null, key: string) => void) =>
				callback(null, microsoft.publicKey.export({ type: 'spki', format: 'pem' }).toString())
		});
		return real;
	}),
	(real) =>
		Effect.sync(() => {
			if (real !== undefined) Object.defineProperty(JwtValidator.prototype, 'getSigningKey', real);
		})
);
const answer = ({ url }: Call) => {
	if (url.includes('login.microsoftonline.com'))
		return json({ access_token: 'bot-token', expires_in: 3600 });
	if (url.endsWith('/activities')) return json({ id: 'out1' });
	if (url.endsWith('/v3/conversations')) return json({ id: 'a:new' });
	if (url.includes('/v3/attachments/')) return new Response(new Uint8Array([1]));
	if (url.includes('sharepoint.test')) return new Response(new Uint8Array([2]));
	return json({});
};
const activity = (extra: object = {}) =>
	JSON.stringify({
		type: 'message',
		id: '1790000000000',
		timestamp: '2026-11-05T10:00:00.000Z',
		serviceUrl: SERVICE,
		from: { id: '29:ann', name: 'Ann' },
		recipient: { id: '28:app-1', name: 'Acme' },
		conversation: { id: 'a:dm', conversationType: 'personal' },
		text: 'hello',
		...extra
	});

describe('Teams', () => {
	it.live('stores a verified activity with exact fields', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			yield* keys;
			const h = yield* connected(teams, settings);
			expect(h.status).toMatchObject({ state: 'connected', account: 'app-1' });
			const body = activity();
			const response = yield* h.link.webhook!(webhook(body, { authorization: token() }));
			expect(response.status).toBe(200);
			expect(h.events[0]).toMatchObject({
				kind: 'messages',
				messages: [
					{
						id: 'a:dm:1790000000000',
						thread: `${SERVICE}|a:dm`,
						sentAt: '2026-11-05T10:00:00.000Z',
						from: { handle: '29:ann', name: 'Ann' },
						text: 'hello',
						group: false,
						invocation: 'direct'
					}
				]
			});
		})
	);
	it.live(
		'a channel mention, a reply, an edit, a delete, its own message and other activities',
		() =>
			Effect.gen(function* () {
				yield* platformApi(answer);
				yield* keys;
				const h = yield* connected(teams, settings);
				const channel = {
					conversation: {
						id: '19:c@thread.tacv2;messageid=5',
						conversationType: 'channel',
						name: 'General'
					}
				};
				const bodies = [
					activity({
						...channel,
						id: '6',
						text: '<at>Acme</at> hi <at>Bob</at>',
						replyToId: '5',
						entities: [
							{ type: 'clientInfo' },
							{ type: 'mention', mentioned: { id: '28:app-1', name: 'Acme' } }
						]
					}),
					activity({
						type: 'messageUpdate',
						id: '6',
						timestamp: '2026-11-05T10:05:00.000Z',
						text: 'edited'
					}),
					activity({ type: 'messageDelete', id: '7', text: undefined }),
					activity({ id: '8', from: { id: '28:app-1' } }),
					activity({ type: 'conversationUpdate', id: '9' })
				];
				for (const body of bodies)
					expect((yield* h.link.webhook!(webhook(body, { authorization: token() }))).status).toBe(
						200
					);
				expect(h.events.length).toBe(3);
				expect(h.events).toMatchObject([
					{
						messages: [
							{
								id: '19:c@thread.tacv2:6',
								thread: `${SERVICE}|19:c@thread.tacv2;messageid=5`,
								text: '@Acme hi @Bob',
								group: true,
								title: 'General',
								replyTo: '19:c@thread.tacv2:5',
								invocation: 'mention'
							}
						]
					},
					{ messages: [{ id: 'a:dm:6', text: 'edited', version: '2026-11-05T10:05:00.000Z' }] },
					{ messages: [{ id: 'a:dm:7', deleted: true, text: '' }] }
				]);
			})
	);
	it.live('reads files, giving its token only to its own Connector', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			yield* keys;
			const h = yield* connected(teams, settings);
			const body = activity({
				attachments: [
					{
						contentType: 'image/png',
						name: 'a.png',
						contentUrl: `${SERVICE}v3/attachments/1/views/original`
					},
					{
						contentType: 'application/vnd.microsoft.teams.file.download.info',
						name: 'b.pdf',
						content: { downloadUrl: 'https://sharepoint.test/b.pdf' }
					},
					{ contentType: 'text/html', content: '<p>hello</p>' }
				]
			});
			yield* h.link.webhook!(webhook(body, { authorization: token() }));
			expect(h.events[0]).toMatchObject({
				bins: [new Uint8Array([1]), new Uint8Array([2])],
				messages: [
					{
						attachments: [
							{ name: 'a.png', mime: 'image/png', bin: 0 },
							{ name: 'b.pdf', mime: 'application/octet-stream', bin: 1 }
						]
					}
				]
			});
			const authorization = (part: string) =>
				api.calls.find(({ url }) => url.includes(part))?.headers.get('authorization');
			expect(authorization('/v3/attachments/')).toBe('Bearer bot-token');
			expect(authorization('sharepoint.test')).toBeNull();
		})
	);
	it.live('refuses a forged key, another app, another service, and no token, storing nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			yield* keys;
			const h = yield* connected(teams, settings),
				body = activity();
			for (const authorization of [
				token({}, stranger.privateKey),
				token({ aud: 'app-2' }),
				token({ iss: 'https://sts.example' }),
				token({ serviceurl: 'https://evil.test/' }),
				token({ exp: 1 })
			])
				expect((yield* h.link.webhook!(webhook(body, { authorization }))).status).toBe(401);
			expect((yield* h.link.webhook!(webhook(body, {}))).status).toBe(401);
			expect((yield* h.link.webhook!(webhook('not json', { authorization: token() }))).status).toBe(
				401
			);
			expect(h.events).toEqual([]);
		})
	);
	it.live('a message the engine did not store is not acknowledged', () =>
		Effect.gen(function* () {
			yield* platformApi(answer);
			yield* keys;
			const h = yield* connected(teams, settings, {
				emit: () => Promise.reject(new Error('the store refused'))
			});
			const response = yield* h.link.webhook!(webhook(activity(), { authorization: token() }));
			expect(response.status).toBe(500);
		})
	);
	it.live('sends through its Connector with one cached token, and types', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(teams, settings);
			const to = `${SERVICE}|19:c@thread.tacv2;messageid=5`;
			const sent = yield* h.link.send!({ id: 'r1', to, text: 'Hello' }, []);
			expect(sent).toMatchObject({ providerId: '19:c@thread.tacv2:out1' });
			const call = api.calls.at(-1);
			expect(call?.url).toBe(
				`${SERVICE}v3/conversations/${encodeURIComponent('19:c@thread.tacv2;messageid=5')}/activities`
			);
			expect(call?.headers.get('authorization')).toBe('Bearer bot-token');
			expect(JSON.parse(call?.body ?? '')).toEqual({
				type: 'message',
				text: 'Hello',
				textFormat: 'markdown'
			});
			yield* h.link.typing!(to, true);
			expect(JSON.parse(api.calls.at(-1)?.body ?? '')).toEqual({ type: 'typing' });
			const login = api.calls.filter(({ url }) => url.includes('login.microsoftonline.com'));
			expect(login.length).toBe(1);
			expect(login[0]?.url).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token');
			expect(Object.fromEntries(new URLSearchParams(login[0]?.body))).toEqual({
				client_id: 'app-1',
				client_secret: 'secret',
				grant_type: 'client_credentials',
				scope: 'https://api.botframework.com/.default'
			});
		})
	);
	it.live('never gives its token to a service that is not Teams', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(teams, settings),
				before = api.calls.length;
			yield* Effect.flip(
				h.link.send!({ id: 'r1', to: 'https://evil.test/|a:dm', text: 'Hello' }, [])
			);
			yield* Effect.flip(
				h.link.send!({ id: 'r2', to: 'http://smba.trafficmanager.net/|a:dm', text: 'Hello' }, [])
			);
			expect(api.calls.length).toBe(before);
		})
	);
	it.live('a test message opens a direct conversation', () =>
		Effect.gen(function* () {
			const api = yield* platformApi(answer);
			const h = yield* connected(teams, settings);
			yield* h.link.test!({ to: '29:ann' });
			expect(api.calls.at(-2)?.url).toBe('https://smba.trafficmanager.net/teams/v3/conversations');
			expect(JSON.parse(api.calls.at(-2)?.body ?? '')).toEqual({
				bot: { id: 'app-1' },
				isGroup: false,
				members: [{ id: '29:ann' }],
				tenantId: 'tenant-1',
				channelData: { tenant: { id: 'tenant-1' } }
			});
			expect(api.calls.at(-1)?.url).toContain('/v3/conversations/a%3Anew/activities');
		})
	);
	it.live('a password Microsoft refuses keeps nothing', () =>
		Effect.gen(function* () {
			yield* platformApi(() => json({ error: 'invalid_client' }, 401));
			const h = yield* host(chatProvider(teams), fetch);
			yield* Effect.flip(h.link.pair!(settings));
			expect(h.values.size).toBe(0);
		})
	);
});
