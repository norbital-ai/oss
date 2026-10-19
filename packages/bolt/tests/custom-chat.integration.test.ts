// A custom chat on PGlite (FINAL §2.1): an http definition that declares `conversation` and `webhook`. Its signed
// deliveries arrive at `/hooks/integration/<instance>`; the links manager checks the signature over the raw body with the
// instance's credential field (the secret never reaches the engine or the guest), the definition's `receive` maps the
// body to messages in one isolate, and they are stored through the conversations' ingest before the 200 — a redelivery
// is the same rows. An envoy deploys on it like on any conversation, senders matched by the declared handle, and every
// outbound message (an envoy reply) leaves through the definition's `send` under the row's immutable key, retried
// until it lands.
import { createHmac, randomBytes } from 'node:crypto';
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import { describe, expect, it } from '@effect/vitest';
import { Context, Effect, Layer, Redacted, Result, Stream } from 'effect';
import { Ai } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { decodeManifest } from '../src/engine/manifest.ts';
import { program } from './support/guest-fixture.ts';
import { actReply, routeFixture } from './support/route-fixture.ts';
import type { Json } from '../src/decl/values.ts';
import type { Outcome } from '../src/engine/contracts.ts';
import { credentials } from '../src/engine/integrations/credentials.ts';
import type { Provider } from '../src/engine/integrations/driver.ts';
import { integrationLinks } from '../src/engine/integrations/links.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { respondSystem1, TestWorkspace } from '../src/test/index.ts';

const PUBLIC = 'https://apex.example/acme',
	HOOK = `${PUBLIC}/hooks/integration/desk`,
	SECRET = 'signing-secret';
const manifest = Result.getOrThrow(
	decodeManifest({
		workspace: { tz: 'UTC', locale: 'en', agent: { triage: false } },
		models: {},
		relationships: {},
		collections: {},
		pipelines: {},
		integrations: {
			support_chat: {
				description: 'Our own support chat app',
				driver: 'http',
				credential: { signing: { kind: 'text' }, token: { kind: 'text' } },
				http: { baseUrl: 'https://chat.example/api', auth: { bearer: 'token' } },
				webhook: { scheme: 'hmac-sha256', secret: 'signing' },
				conversation: { kind: 'chat', handle: 'phone' }
			}
		},
		connections: { desk: { integration: 'support_chat', envoy: 'helper' } },
		envoys: {
			helper: {
				audience: 'private',
				name: 'Norbius',
				policies: ['desk'],
				triage: false,
				delegation: 'disabled',
				task: 'Help customers.'
			}
		},
		policies: { desk: { description: 'What the envoy may do', grants: {} } },
		teams: {},
		automations: {},
		mcp: {},
		apps: {},
		customFields: {},
		agent: { skills: {} }
	})
);

/** `receive` maps the app's events (it would see an `authorization` header as the sender's name); `send` posts under `ctx.key`. */
const guest =
	program(`export default { integration_definition: { support_chat: { bodies: { feeds: {}, outbound: {},
	receive: function* ({ body, headers }) { return { messages: body.events.map((e) => ({ id: e.id, thread: e.chat, sentAt: e.at,
		from: { handle: e.from, name: headers.authorization ?? null }, text: e.text })) }; },
	send: function* (message, ctx) { return yield* ctx.request({ method: 'POST', path: '/messages', headers: { 'idempotency-key': ctx.key },
		body: { chat: message.thread, to: message.to, text: message.text }, output: { kind: 'object', fields: { id: { kind: 'text' } } } }); },
} } } };`);
const ports = Layer.succeed(Ai, {
	ask: respondSystem1,
	maxChoices: undefined,
	models: ['default'],
	catalog: Port.unavailable('ai.catalog'),
	embed: () => Port.unavailable('ai.embed'),
	infer: () =>
		Stream.fromIterable([
			{
				_tag: 'Response' as const,
				response: {
					content: 'Happy to help.',
					toolCalls: [],
					finish: 'stop' as const,
					usage: { input: 10, output: 5 }
				}
			}
		])
});

/** The host's http provider, as far as pairing goes: the definition's credential form, sealed as `credential`. */
const http: Provider = {
	driver: 'http',
	id: 'http',
	label: 'HTTP',
	setup: { kind: 'form', steps: [], webhook: true },
	async open(ctx) {
		return {
			async pair(input) {
				await ctx.credentials.write(new Map([['credential', input]]));
				await ctx.status({ state: 'connected' });
			},
			async test() {},
			async close() {}
		};
	}
};

const NOW = '2026-10-14T09:00:00.000Z';
const setup = () =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest,
				guest: yield* guest,
				ports,
				now: NOW,
				secretsKey: Redacted.make(randomBytes(32))
			})
		);
		const t = Context.get(context, TestWorkspace);
		const links = yield* integrationLinks({
			providers: [http],
			enter: (work) => work.pipe(Effect.provide(context)),
			credentials: yield* credentials(t.db, Context.get(context, Secrets)).pipe(
				Effect.provide(NodeCrypto.layer)
			),
			publicUrl: PUBLIC,
			log: () => {}
		}).pipe(Effect.provide(NodeCrypto.layer));
		yield* t.db.write({
			text: `INSERT INTO sys_user (id, email, name, phone) VALUES ('u-ada', 'ada@ws.example', 'Ada', '+65 9123 4567')`,
			params: []
		});
		const requests: { instance: string; op: Json }[] = [];
		let down = 0;
		t.fakes.links.answer = (instance, op) =>
			Effect.sync(() => {
				requests.push({ instance, op });
				if (down > 0) {
					down--;
					return { status: 503, body: 'try later' };
				}
				return { status: 200, body: { id: `remote-${requests.length}` } };
			});
		const deliver = (body: Json, headers: { [k: string]: string } = {}, sign = SECRET) => {
			const raw = JSON.stringify(body);
			return links.webhook(
				'desk',
				new Request(HOOK, {
					method: 'POST',
					body: raw,
					headers: {
						'content-type': 'application/json',
						'x-signature': `sha256=${createHmac('sha256', sign).update(raw).digest('hex')}`,
						...headers
					}
				})
			);
		};
		const sql = (text: string) =>
			t.db.read([{ text, params: [] }]).pipe(Effect.map((r) => r[0]?.rows ?? []));
		const inbound = () =>
			sql(
				`SELECT integration, provider_id, sender, sender_name, text FROM sys_message WHERE direction = 'inbound' ORDER BY seq`
			);
		return {
			t,
			links,
			requests,
			sql,
			inbound,
			deliver,
			failNext: () => {
				down = 1;
			},
			route: yield* routeFixture(context)
		};
	});
const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const event = (id: string, text: string, from = '6591234567') => ({
	id,
	chat: `chat-${from}`,
	from,
	at: NOW,
	text
});

describe('a custom chat', () => {
	it.live(
		'refuses a delivery its signature does not prove: 401, and nothing is stored or run',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { links, deliver, inbound, sql } = yield* setup();
					expect(yield* deliver({ events: [event('e1', 'hi')] })).toMatchObject({ status: 401 }); // not paired: no secret to check with
					yield* links.pair('desk', { signing: SECRET, token: 'app-token' });
					expect(
						(yield* deliver({ events: [event('e1', 'hi')] }, {}, 'a-guessed-secret')).status
					).toBe(401);
					const raw = JSON.stringify({ events: [event('e1', 'hi')] });
					expect(
						(yield* links.webhook('desk', new Request(HOOK, { method: 'POST', body: raw }))).status
					).toBe(401);
					expect(yield* inbound()).toEqual([]);
					expect(yield* sql(`SELECT automation FROM sys_run`)).toEqual([]);
					// an instance that is no custom chat has no such door
					expect(
						(yield* links.webhook('nowhere', new Request(HOOK, { method: 'POST', body: raw })))
							.status
					).toBe(404);
				})
			)
	);

	it.live(
		'stores a verified delivery before the 200; a redelivery is the same rows, admitted once; the secret never reaches the guest',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, links, deliver, inbound, sql, route } = yield* setup();
					yield* links.pair('desk', { signing: SECRET, token: 'app-token' });
					const body = { events: [event('e1', 'hello'), event('e2', 'anyone there?')] };
					expect((yield* deliver(body, { authorization: `Bearer ${SECRET}` })).status).toBe(200);
					const stored = yield* inbound();
					expect(stored).toEqual([
						{
							integration: 'desk',
							provider_id: 'e1',
							sender: '6591234567',
							sender_name: null,
							text: 'hello'
						},
						{
							integration: 'desk',
							provider_id: 'e2',
							sender: '6591234567',
							sender_name: null,
							text: 'anyone there?'
						}
					]);
					expect((yield* deliver(body)).status).toBe(200);
					expect(yield* inbound()).toEqual(stored);
					expect(
						yield* sql(`SELECT count(*)::int AS n FROM sys_run WHERE automation = 'envoys.admit'`)
					).toEqual([{ n: 2 }]);
					// a body that is no JSON object is refused before receive runs
					const raw = 'not json';
					expect(
						(yield* links.webhook(
							'desk',
							new Request(HOOK, {
								method: 'POST',
								body: raw,
								headers: { 'x-signature': createHmac('sha256', SECRET).update(raw).digest('hex') }
							})
						)).status
					).toBe(400);
					// a paused instance asks the app to deliver again later
					ok(
						(yield* actReply(route, t.as(t.admin).authority, {
							callable: 'sys_integration.update',
							input: { target: 'desk', set: { active: false } },
							issuedAt: t.clock.now()
						})).outcome
					);
					expect((yield* deliver({ events: [event('e3', 'still there?')] })).status).toBe(503);
					expect(yield* inbound()).toHaveLength(2);
				})
			)
	);

	it.live(
		'an envoy answers a linked sender; the reply leaves through send under the row’s key, a failure retried under the same key',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, links, requests, deliver, sql, failNext } = yield* setup();
					yield* links.pair('desk', { signing: SECRET, token: 'app-token' });
					failNext();
					expect(
						(yield* deliver({ events: [event('e1', 'is my order ready?', '+65 9123 4567')] }))
							.status
					).toBe(200);
					yield* t.runDue();
					yield* t.settled();
					expect(
						(yield* sql(`SELECT "as" FROM sys_message WHERE provider_id = 'e1'`))[0]
					).toMatchObject({
						as: { envoy: { name: 'helper', instance: 'desk', member: 'u-ada', dm: true } }
					});
					const [reply] = yield* sql(
						`SELECT id, status, text FROM sys_message WHERE direction = 'outbound'`
					);
					expect(reply).toMatchObject({ status: 'queued', text: 'Happy to help.' });
					t.clock.advance('2s');
					yield* t.runDue();
					expect(
						yield* sql(`SELECT status, provider_id FROM sys_message WHERE direction = 'outbound'`)
					).toEqual([{ status: 'sent', provider_id: 'remote-2' }]);
					// both attempts carried the row's immutable key; the bearer token stayed host-side, and no link sent anything
					expect(requests).toEqual(
						[1, 2].map(() => ({
							instance: 'desk',
							op: {
								method: 'POST',
								path: '/messages',
								headers: { 'idempotency-key': reply!['id'] },
								body: {
									chat: 'chat-+65 9123 4567',
									to: 'chat-+65 9123 4567',
									text: 'Happy to help.'
								}
							}
						}))
					);
					expect(t.fakes.links.sent).toEqual([]);
				})
			)
	);

	it.live(
		'takes an envoy on an instance an administrator creates, like any conversation, and tests as a request instance',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, links, sql, route } = yield* setup();
					const id = ok(
						(yield* actReply(route, t.as(t.admin).authority, {
							callable: 'sys_integration.create',
							input: { integration: 'support_chat', name: 'Second desk' },
							issuedAt: t.clock.now()
						})).outcome
					).records[0]!.id;
					ok(
						(yield* actReply(route, t.as(t.admin).authority, {
							callable: 'sys_integration.update',
							input: { target: id, set: { envoy: 'helper' } },
							issuedAt: t.clock.now()
						})).outcome
					);
					expect(
						yield* sql(`SELECT envoy FROM sys_integration WHERE name = 'Second desk'`)
					).toEqual([{ envoy: 'helper' }]);
					// its test is its request link's and the definition's own (none declared passes), never a chat round trip
					expect(yield* links.test(id, {})).toBeUndefined();
				})
			)
	);
});
