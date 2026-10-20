// engine/integrations/links.ts on PGlite (§4.5): the host half every host shares — one link per instance from the
// provider the operator paired it through, credentials sealed per instance under the opener's epoch, resume from the
// instance rows, per-instance webhooks under the workspace's public path, durable status only on durable transitions,
// a second opener fencing the first for good, credential writes retried until they land, request links per call, and
// the instance verbs (`/__bolt/integrations/<instance>/…`) authorized as "may update this row".
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	FiberSet,
	Layer,
	Option,
	Predicate,
	Queue,
	Redacted,
	Result,
	Schedule,
	Schema,
	Stream
} from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/unstable/http';
import { Drivers } from '../src/engine/ports.ts';
import { Port } from '../src/engine/port.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import type { DriverName, IntegrationSpec } from '../src/decl/runtime/integration.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { DbError, Fenced } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { credentials, type Credentials } from '../src/engine/integrations/credentials.ts';
import {
	oauthClientOf,
	type DriverOpen,
	type Link,
	type Provider
} from '../src/engine/integrations/driver.ts';
import {
	decodeStatus,
	type InstanceStatus,
	type LinkStatus
} from '../src/protocol/instance-status.ts';
import {
	integrationLinks,
	type LinkManager,
	type LinksHost
} from '../src/engine/integrations/links.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { IntegrationManager } from '../src/protocol/integrations.ts';
import { BoltHost, BoltHostLive } from '../src/protocol/host.ts';
import { RateLimits, SessionAuthority } from '../src/protocol/http.ts';
import { ShellRoutes } from '../src/shell/host.ts';
import {
	TestWorkspace,
	type Kit,
	type TestOptions,
	type WorkspaceServices
} from '../src/test/index.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const PUBLIC = 'https://apex.example/acme';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	collections: {},
	pipelines: {},
	integrations: {
		erp: {
			description: 'The ERP',
			driver: 'http',
			credential: { apiKey: { kind: 'text', label: 'API key' } },
			http: {
				baseUrl: 'https://erp.example/api',
				auth: { header: { name: 'x-api-key', value: 'apiKey' } }
			}
		}
	},
	connections: {
		a: { integration: 'whatsapp' },
		b: { integration: 'whatsapp' },
		mail: { integration: 'email' },
		tg: { integration: 'telegram' },
		erp: { integration: 'erp' }
	},
	policies: {
		self: {
			description: 'Manages their own accounts',
			grants: {
				sys_integration: { read: true, update: { where: { owner: { eq: { actor: 'id' } } } } }
			}
		}
	},
	teams: {},
	automations: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} }
} satisfies EngineManifest;

const ok = (o: Outcome) => {
	if (o.kind !== 'committed') throw new Error(JSON.stringify(o));
	return o;
};
const chat = (id: string) => ({
	id,
	thread: '6591234567@s.whatsapp.net',
	sentAt: '2026-10-14T10:00:00.000Z',
	from: { handle: '6591234567@s.whatsapp.net', name: 'Ben' },
	text: 'hi',
	attachments: []
});
const post = (body: Json, path = '/x') =>
	new Request(`${PUBLIC}${path}`, { method: 'POST', body: JSON.stringify(body) });
class PairingInvalid extends Schema.TaggedError<PairingInvalid>()('PairingInvalid', {
	message: Schema.String
}) {}

/** A provider that pairs on `{ key }` and refuses anything else; it records the contexts it opened with. */
const fake = (
	id: string,
	opened: DriverOpen[] = [],
	driver: DriverName = 'whatsapp',
	over: Partial<Provider> = {}
): Provider => ({
	driver,
	personal: true,
	id,
	label: `Fake ${id}`,
	setup: {
		kind: 'form',
		steps: [{ text: 'Paste the key' }],
		fields: [{ name: 'key', label: 'Key', secret: true }],
		webhook: true
	},
	async open(ctx) {
		opened.push(ctx);
		const stored = (await ctx.credentials.load()).get('credential');
		if (Predicate.isObject(stored))
			await ctx.status({ state: 'connected', account: String(stored['key']) });
		return {
			async send(message) {
				return {
					providerId: `${id}:${ctx.instance}:${String(Predicate.isObject(message) ? message['text'] : undefined)}`
				};
			},
			async pair(input) {
				const key = Predicate.isObject(input) ? input['key'] : undefined;
				if (typeof key !== 'string') throw new PairingInvalid({ message: 'a key is required' });
				await ctx.credentials.write(new Map([['credential', { key }]]));
				await ctx.status({ state: 'connected', account: key });
			},
			async webhook(req) {
				await ctx.emit({
					kind: 'messages',
					messages: [Schema.decodeUnknownSync(Schema.Json)(await req.json())]
				});
				return new Response('ok');
			},
			async close() {}
		};
	},
	...over
});

const key = randomBytes(32);
const open = (m: EngineManifest = manifest, ports?: TestOptions<Drivers>['ports']) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: m,
				host: { publicUrl: PUBLIC },
				secretsKey: Redacted.make(key),
				...(ports === undefined ? {} : { ports })
			})
		);
		const t = Context.get(context, TestWorkspace),
			store = yield* credentials(t.db, Context.get(context, Secrets)).pipe(
				Effect.provide(NodeCrypto.layer)
			),
			route = yield* routeFixture(context);
		const host = (providers: readonly Provider[], over: Partial<LinksHost> = {}) =>
			integrationLinks({
				providers,
				enter: (effect) => effect.pipe(Effect.provide(context)),
				credentials: store,
				publicUrl: PUBLIC,
				log: () => {},
				...over
			}).pipe(Effect.provide(NodeCrypto.layer));
		const sealed = (instance: string) =>
			store.read(instance).pipe(Effect.map((stored) => Object.fromEntries(stored.values)));
		const row = (instance: string) =>
			t.db
				.read([
					{
						text: 'SELECT status, revision, epoch, active FROM sys_integration WHERE id = $1',
						params: [instance]
					}
				])
				.pipe(
					Effect.map(([result]) => {
						const row = result?.rows[0];
						if (row === undefined) throw new Error('Missing instance row');
						return row;
					})
				);
		const act = (authority: Authority, callable: string, input: Json) =>
			actReply(route, authority, { callable, input, issuedAt: t.clock.now() }).pipe(
				Effect.map((reply) => reply.outcome)
			);
		return { t, context, store, route, host, sealed, row, act };
	});
const DriverFailure = Schema.Union([BoltError, DbError, Fenced]);
const driverCall = <A>(call: () => Promise<A>) =>
	Effect.tryPromise({
		try: call,
		catch: (error) => Schema.decodeUnknownSync(DriverFailure)(error)
	});
const until = (done: () => boolean) =>
	Effect.sync(done).pipe(
		Effect.repeat({ schedule: Schedule.spaced('10 millis'), until: (done) => done, times: 200 }),
		Effect.tap((done) => Effect.sync(() => expect(done).toBe(true)))
	);

describe('instance links', () => {
	it.live(
		'a driver with two providers asks which; each instance pairs, seals and sends through its own',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { host, sealed } = yield* open();
					const links = yield* host([fake('twilio'), fake('baileys')]);
					expect(yield* links.pair('a', { key: 'k1' }).pipe(Effect.flip)).toMatchObject({
						message: expect.stringMatching(/choose how to connect.*twilio, baileys/)
					});
					yield* links.pair('a', { provider: 'twilio', key: 'k1' });
					yield* links.pair('b', { provider: 'baileys', key: 'k2' });
					expect(yield* sealed('a')).toEqual({ provider: 'twilio', credential: { key: 'k1' } });
					expect(yield* links.state('a')).toMatchObject({
						instance: 'a',
						integration: 'whatsapp',
						driver: 'whatsapp',
						state: 'connected',
						provider: 'twilio',
						account: 'k1',
						stored: true,
						about: { webhookUrl: 'https://apex.example/acme/hooks/integration/a' }
					});
					expect(present(present(yield* links.state('a')).providers).map((p) => p.id)).toEqual([
						'twilio',
						'baileys'
					]);
					expect(yield* links.port.send('a', { text: 'x' }, [])).toEqual({
						providerId: 'twilio:a:x'
					});
					expect(yield* links.port.send('b', { text: 'y' }, [])).toEqual({
						providerId: 'baileys:b:y'
					});
					expect(yield* links.port.send('tg', { text: 'z' }, []).pipe(Effect.flip)).toMatchObject({
						message: expect.stringMatching(/not connected/)
					});
					yield* links.close;
				})
			)
	);

	it.live(
		'a refused pairing keeps nothing; unpair destroys the credentials and records the instance unpaired',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { host, sealed, row } = yield* open();
					const links = yield* host([fake('twilio')]);
					expect(yield* links.pair('a', {}).pipe(Effect.flip)).toMatchObject({
						message: expect.stringMatching(/key is required/)
					});
					expect(yield* sealed('a')).toEqual({});
					expect(present(yield* links.state('a')).state).toBe('unpaired');
					yield* links.pair('a', { key: 'k' });
					expect((yield* row('a'))['status']).toMatchObject({ state: 'connected', account: 'k' });
					yield* links.unpair('a');
					expect(yield* sealed('a')).toEqual({});
					expect((yield* row('a'))['status']).toMatchObject({ state: 'unpaired', account: null });
					expect(yield* links.state('a')).toMatchObject({ state: 'unpaired', stored: false });
					expect(yield* links.port.send('a', { text: 'x' }, []).pipe(Effect.flip)).toMatchObject({
						message: expect.stringMatching(/not connected/)
					});
					yield* links.close;
				})
			)
	);

	it.live(
		'resume opens only active instances that store a registered provider; the webhook routes by instance and resolves after the engine committed',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, store, host, sealed, act } = yield* open();
					const opened: DriverOpen[] = [];
					const first = yield* host([fake('baileys'), fake('bot', opened, 'telegram')]);
					yield* first.pair('b', { key: 'k2' });
					yield* first.pair('tg', { key: 'k3' });
					yield* first.close;
					// one sealed for a provider this host does not register, one paused
					const o = yield* store.open('a');
					yield* store.write(
						'a',
						o.epoch,
						new Map<string, Json>([
							['provider', 'gone'],
							['credential', { key: 'x' }]
						])
					);
					ok(
						yield* act(t.as(t.admin).authority, 'sys_integration.update', {
							target: 'tg',
							set: { active: false }
						})
					);
					opened.length = 0;
					const resumedWith: DriverOpen[] = [];
					const links = yield* host([
						fake('baileys', resumedWith),
						fake('twilio'),
						fake('bot', opened, 'telegram')
					]);
					yield* links.resume;
					expect(resumedWith.map((c) => [c.instance, c.personal, c.webhookUrl])).toEqual([
						['b', false, 'https://apex.example/acme/hooks/integration/b']
					]);
					expect(opened).toEqual([]);
					expect((yield* links.webhook('b', post(chat('W1')))).status).toBe(200);
					// the answer came after the ingest committed
					const [m] = yield* t.db.read([
						{
							text: `SELECT integration, provider_id FROM sys_message WHERE direction = 'inbound'`,
							params: []
						}
					]);
					expect(present(m).rows).toEqual([{ integration: 'b', provider_id: 'W1' }]);
					expect((yield* links.webhook('a', post(chat('W2')))).status).toBe(404);
					yield* links.close;
				})
			)
	);

	it.live(
		'an emit resolves once its rows are committed; one the engine refuses rejects, so the provider acknowledges nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, host } = yield* open();
					const opened: DriverOpen[] = [];
					const links = yield* host([fake('fake', opened)]);
					yield* links.pair('a', { key: 'k' });
					yield* driverCall(() =>
						present(opened[0]).emit({ kind: 'messages', messages: [chat('W1')] })
					);
					expect(
						present(
							(yield* t.db.read([
								{ text: `SELECT provider_id FROM sys_message WHERE integration = 'a'`, params: [] }
							]))[0]
						).rows
					).toEqual([{ provider_id: 'W1' }]);
					yield* t.db.write({ text: `DELETE FROM sys_integration WHERE id = 'a'`, params: [] });
					expect(
						yield* driverCall(() =>
							present(opened[0]).emit({ kind: 'messages', messages: [chat('W2')] })
						).pipe(Effect.flip)
					).toMatchObject({ code: 'notFound' });
					yield* links.close;
				})
			)
	);
});

describe('durable status and the epoch fence', () => {
	it.live('closing the owner ends its status stream and preserves the final stored snapshot', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { host, sealed, row } = yield* open();
				const opened: DriverOpen[] = [];
				const links = yield* host([fake('p', opened)]);
				yield* links.pair('a', { key: 'k' });
				const statuses = yield* Queue.unbounded<InstanceStatus>();
				const watch = yield* links.watch('a').pipe(
					Stream.runForEach((status) => Queue.offer(statuses, status)),
					Effect.forkScoped
				);
				expect(yield* Queue.take(statuses)).toMatchObject({ state: 'connected', account: 'k' });
				yield* links.close;
				yield* Fiber.join(watch);
				yield* links.close;
				expect((yield* row('a'))['status']).toMatchObject({ state: 'connected', account: 'k' });
				expect(yield* links.state('a')).toMatchObject({ state: 'connected', account: 'k' });
				expect(yield* sealed('a')).toEqual({ provider: 'p', credential: { key: 'k' } });
				expect(yield* links.pair('a', { key: 'again' }).pipe(Effect.flip)).toMatchObject({
					code: 'unavailable',
					message: 'the integration links are closed'
				});
				yield* links.resume;
				expect(opened).toHaveLength(1);
			})
		)
	);

	it.live(
		'lands a durable transition on the row once; a reconnect stays in memory and on the stream',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { host, row } = yield* open();
					let ctx: DriverOpen | undefined;
					const links = yield* host([
						fake('p', [], 'whatsapp', {
							async open(c) {
								ctx = c;
								return {
									async close() {},
									async pair() {
										await c.status({ state: 'connected', account: '+65 1' });
									}
								};
							}
						})
					]);
					yield* links.pair('a', {});
					const seen: InstanceStatus[] = [];
					const watched = yield* Queue.unbounded<InstanceStatus>();
					const watch = yield* links.watch('a').pipe(
						Stream.runForEach((status) =>
							Effect.gen(function* () {
								seen.push(status);
								yield* Queue.offer(watched, status);
							})
						),
						Effect.forkScoped
					);
					expect((yield* Queue.take(watched)).state).toBe('connected');
					const at = (yield* row('a'))['revision'];
					expect((yield* row('a'))['status']).toMatchObject({
						state: 'connected',
						account: '+65 1'
					});
					yield* driverCall(() =>
						present(ctx).status({ state: 'reconnecting', detail: 'the socket dropped' })
					);
					expect((yield* row('a'))['revision']).toBe(at);
					expect(present(yield* links.state('a')).state).toBe('reconnecting');
					yield* driverCall(() => present(ctx).status({ state: 'connected', account: '+65 1' }));
					expect((yield* row('a'))['revision']).toBe(at);
					present(ctx).pairing({ kind: 'qr', value: '2@abc' });
					while (seen.length < 4) yield* Queue.take(watched);
					expect(seen.map((s) => s.state)).toEqual([
						'connected',
						'reconnecting',
						'connected',
						'connected'
					]);
					expect(present(seen.at(-1)).pairing).toEqual({ kind: 'qr', value: '2@abc' });
					yield* driverCall(() =>
						present(ctx).status({ state: 'error', code: 'loggedOut', error: 'Pair again' })
					);
					expect((yield* row('a'))['status']).toMatchObject({
						state: 'error',
						code: 'loggedOut',
						error: 'Pair again',
						since: expect.any(String)
					});
					yield* Fiber.interrupt(watch);
					yield* links.close;
				})
			)
	);

	it.live(
		'a second opener fences the first: its next credential write stops it for good as replaced, with no reconnect',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { host, sealed, row } = yield* open();
					const firstOpened: DriverOpen[] = [],
						secondOpened: DriverOpen[] = [];
					const first = yield* host([fake('p', firstOpened)]),
						second = yield* host([fake('p', secondOpened)]);
					yield* first.pair('a', { key: 'k1' });
					const epoch = (yield* row('a'))['epoch'];
					yield* second.resume;
					expect(secondOpened).toHaveLength(1);
					expect((yield* row('a'))['epoch']).not.toBe(epoch);
					expect(
						yield* driverCall(() =>
							present(firstOpened[0]).credentials.write(new Map([['state', { n: 1 }]]))
						).pipe(Effect.flip)
					).toMatchObject({ _tag: 'Fenced' });
					expect(present(firstOpened[0]).signal.aborted).toBe(true);
					expect(yield* first.state('a')).toMatchObject({ state: 'error', code: 'replaced' });
					expect(
						yield* driverCall(() =>
							present(firstOpened[0]).credentials.write(new Map([['state', { n: 2 }]]))
						).pipe(Effect.flip)
					).toMatchObject({ _tag: 'Fenced' });
					yield* driverCall(() => present(firstOpened[0]).status({ state: 'connected' }));
					expect(yield* first.state('a')).toMatchObject({ state: 'error', code: 'replaced' });
					expect(yield* first.port.send('a', { text: 'x' }, []).pipe(Effect.flip)).toMatchObject({
						_tag: 'Fenced'
					});
					expect(
						yield* driverCall(() =>
							present(firstOpened[0]).emit({ kind: 'messages', messages: [chat('W1')] })
						).pipe(Effect.flip)
					).toMatchObject({ _tag: 'Fenced' });
					yield* first.resume;
					expect(firstOpened).toHaveLength(1); // no reconnect
					expect(yield* sealed('a')).toEqual({ provider: 'p', credential: { key: 'k1' } });
					expect(yield* second.port.send('a', { text: 'y' }, [])).toEqual({ providerId: 'p:a:y' });
					yield* first.close;
					yield* second.close;
				})
			)
	);

	it.live(
		'two calls of a request link that read the same credentials: the second to write is fenced and changes nothing',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { host, sealed } = yield* open();
					let arrived = 0;
					const both = yield* Deferred.make<void>(),
						runProvider = yield* FiberSet.makeRuntimePromise();
					const http: Provider = {
						driver: 'http',
						id: 'http',
						label: 'HTTP',
						setup: { kind: 'form', steps: [] },
						async open(ctx) {
							return {
								async pair(input) {
									await ctx.credentials.write(new Map([['credential', input]]));
									await ctx.status({ state: 'connected' });
								},
								// a refresh: each call read the token, then stores the one it got
								async request(op) {
									await ctx.credentials.load();
									if (++arrived === 2) await runProvider(Deferred.succeed(both, undefined));
									await runProvider(Deferred.await(both));
									await ctx.credentials.write(new Map([['token', op]]));
									return op;
								},
								async close() {}
							};
						}
					};
					const links = yield* host([http]);
					yield* links.pair('erp', { apiKey: 'k' });
					const calls = yield* Effect.all(
						[links.port.request('erp', 'first'), links.port.request('erp', 'second')],
						{ concurrency: 'unbounded', mode: 'result' }
					);
					expect(
						calls.map((result) => (Result.isSuccess(result) ? 'fulfilled' : 'rejected')).sort()
					).toEqual(['fulfilled', 'rejected']);
					expect(calls.find(Result.isFailure)).toMatchObject({ failure: { _tag: 'Fenced' } });
					const successful = calls.find(Result.isSuccess);
					if (successful === undefined) throw new Error('Missing winning request');
					const won = successful.success;
					expect(yield* sealed('erp')).toEqual({
						provider: 'http',
						credential: { apiKey: 'k' },
						token: won
					});
					// the losing call replaced nothing: the instance still answers
					expect(yield* links.port.request('erp', 'third')).toBe('third');
					yield* links.close;
				})
			)
	);

	it.live('retries a failed credential write until it lands; it is never shed', () =>
		Effect.scoped(
			Effect.gen(function* () {
				let { store, host, sealed } = yield* open();
				let failures = 2;
				const flaky: Credentials = {
					...store,
					write: (i, e, c, rotate) =>
						Effect.suspend(() => {
							if (failures-- > 0)
								return Effect.fail(
									BoltError.make('busy', 'admission', 'a release cutover holds admission closed')
								);
							return store.write(i, e, c, rotate);
						})
				};
				const opened: DriverOpen[] = [];
				const links = yield* host([fake('p', opened)], { credentials: flaky });
				failures = 0;
				yield* links.pair('a', { key: 'k1' });
				failures = 2;
				yield* driverCall(() =>
					present(opened[0]).credentials.write(new Map([['state', { cursor: 7 }]]))
				);
				expect(failures).toBe(-1);
				expect(yield* sealed('a')).toMatchObject({ state: { cursor: 7 } });
				yield* links.close;
			})
		)
	);
});

describe('request links', () => {
	const http = (opened: DriverOpen[]): Provider => ({
		driver: 'http',
		id: 'http',
		label: 'HTTP',
		setup: { kind: 'form', steps: [] },
		describe: ({ definition }) => ({
			label: 'HTTP',
			setup: {
				kind: 'form',
				steps: [],
				fields: Object.keys(definition.credential ?? {}).map((name) => ({
					name,
					label: name,
					secret: true
				}))
			}
		}),
		async open(ctx): Promise<Link> {
			opened.push(ctx);
			return {
				async close() {},
				async pair(input) {
					await ctx.credentials.write(new Map([['credential', input]]));
					await ctx.status({ state: 'connected' });
				},
				async request(op) {
					return {
						status: 200,
						body: { op, credential: (await ctx.credentials.load()).get('credential') ?? null }
					};
				}
			};
		}
	});
	it.live(
		'open per call with the credentials as they are, take no epoch, and pair from the definition’s own credential fields',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { host, row } = yield* open();
					const opened: DriverOpen[] = [];
					const links = yield* host([http(opened)]);
					expect(
						present(present(present(yield* links.state('erp')).providers)[0]).setup.fields
					).toEqual([{ name: 'apiKey', label: 'apiKey', secret: true }]);
					yield* links.pair('erp', { apiKey: 's3cret' });
					const epoch = (yield* row('erp'))['epoch'];
					expect(yield* links.port.request('erp', { method: 'GET', path: '/orders' })).toEqual({
						status: 200,
						body: { op: { method: 'GET', path: '/orders' }, credential: { apiKey: 's3cret' } }
					});
					yield* links.port.request('erp', { method: 'GET', path: '/orders' });
					expect(opened.map((c) => c.instance)).toEqual(['erp', 'erp', 'erp']);
					expect((yield* row('erp'))['epoch']).toBe(epoch);
					expect(opened.every((c) => c.signal.aborted)).toBe(true);
					expect(yield* links.state('erp')).toMatchObject({ state: 'connected', stored: true });
					yield* links.resume;
					expect(opened).toHaveLength(3); // resume opens no request link
					yield* links.close;
				})
			)
	);
});

describe('the instance verbs', () => {
	const member = (t: Kit, policies: readonly string[], over = {}) =>
		t.as(t.member(policies, over)).authority;
	const verbs = (
		workspace: Context.Context<TestWorkspace | WorkspaceServices>,
		links: LinkManager,
		who: Authority | null
	) => {
		const acquire = Effect.gen(function* () {
			const base = Layer.mergeAll(
				NodeCrypto.layer,
				Layer.succeedContext(workspace),
				Layer.succeed(IntegrationManager, Option.some(links))
			);
			const shell = ShellRoutes.pipe(
				Layer.provideMerge(RateLimits.layer),
				Layer.provideMerge(base)
			);
			const context = yield* Layer.build(
				BoltHostLive.pipe(
					Layer.provideMerge(
						Layer.merge(
							shell,
							Layer.succeed(SessionAuthority, {
								of: () => Effect.succeed(Option.fromNullishOr(who))
							})
						)
					)
				)
			);
			return { context, host: Context.get(context, BoltHost) };
		});
		let cached: typeof acquire | undefined;
		const opened = Effect.gen(function* () {
			cached ??= yield* Effect.cached(acquire);
			return yield* cached;
		});
		return (request: Request) =>
			Effect.gen(function* () {
				const { host, context } = yield* opened;
				const response = yield* host.handle(HttpServerRequest.fromWeb(request));
				return Option.isSome(response)
					? HttpServerResponse.toWeb(response.value, { context })
					: null;
			});
	};
	// a host routes the verbs with the workspace's path prefix stripped
	const url = (instance: string, verb = '') =>
		`https://apex.example/__bolt/integrations/${encodeURIComponent(instance)}${verb === '' ? '' : `/${verb}`}`;
	const call = (
		h: ReturnType<typeof verbs>,
		instance: string,
		verb = '',
		body?: Json,
		headers: Record<string, string> = {}
	) =>
		h(
			new Request(
				url(instance, verb),
				body === undefined ? { headers } : { method: 'POST', body: JSON.stringify(body), headers }
			)
		);

	it.live(
		'answer the one InstanceStatus, refusals in the provider’s own words, and a driver with no provider here as Unavailable',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, context, host } = yield* open();
					const links = yield* host([fake('twilio')]);
					const h = verbs(context, links, t.as(t.admin).authority);
					const got = yield* call(h, 'a');
					expect(
						decodeStatus(
							(yield* Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.Json }))(
								yield* json(present(got))
							)).value
						)?.providers?.[0]?.setup.fields
					).toEqual([{ name: 'key', label: 'Key', secret: true }]);
					expect(present(yield* call(h, 'a', 'pair', { key: 'k' })).status).toBe(200);
					expect(yield* json(present(yield* call(h, 'b', 'pair', {})))).toEqual({
						error: { code: 'invalidInput', message: 'a key is required' }
					});
					expect(present(yield* call(h, 'tg', 'pair', {})).status).toBe(503);
					expect(present(yield* call(h, 'nope')).status).toBe(404);
					const stream = yield* h(new Request(url('a', 'stream')));
					const reader = present(present(stream).body).getReader();
					const first = yield* Effect.tryPromise({
						try: () => reader.read(),
						catch: Port.failure('link.stream')
					});
					yield* Effect.addFinalizer(() =>
						Effect.tryPromise({
							try: () => reader.cancel(),
							catch: Port.failure('link.stream')
						}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
					);
					expect(new TextDecoder().decode(first.value)).toMatch(/^data: .*"state":"connected"/);
					expect(yield* h(new Request('https://apex.example/__bolt/elsewhere'))).toBeNull();
					yield* links.close;
				})
			)
	);

	it.live(
		'authorize as "may update this row": the owner and an administrator, never another member, an external one, a visitor or another site',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, context, host, sealed, act } = yield* open();
					const links = yield* host([fake('p')]);
					const alice = t.member(['self'], { email: 'alice@ws.example' });
					const phone = present(
						ok(
							yield* act(t.as(t.admin).authority, 'sys_integration.create', {
								integration: 'whatsapp',
								name: 'Alice’s phone',
								owner: alice.id
							})
						).records[0]
					).id;
					expect(present(yield* call(verbs(context, links, null), phone)).status).toBe(401);
					expect(
						present(
							yield* call(verbs(context, links, member(t, ['self'])), phone, 'pair', { key: 'x' })
						).status
					).toBe(403);
					expect(
						present(
							yield* call(verbs(context, links, member(t, ['self'], { external: true })), phone)
						).status
					).toBe(403);
					expect(
						present(yield* call(verbs(context, links, t.as(alice).authority), 'a')).status
					).toBe(403); // a workspace instance is not hers
					expect(
						present(
							yield* call(
								verbs(context, links, t.as(alice).authority),
								phone,
								'pair',
								{ key: 'x' },
								{ 'sec-fetch-site': 'cross-site' }
							)
						).status
					).toBe(403);
					expect(yield* sealed(phone)).toEqual({});
					expect(
						present(
							yield* call(verbs(context, links, t.as(alice).authority), phone, 'pair', {
								key: 'mine'
							})
						).status
					).toBe(200);
					expect(
						present(yield* call(verbs(context, links, t.as(t.admin).authority), phone)).status
					).toBe(200);
					// a personal account sends no test message
					expect(
						yield* json(
							present(yield* call(verbs(context, links, t.as(alice).authority), phone, 'test', {}))
						)
					).toEqual({
						error: { code: 'invalidInput', message: 'A personal account sends no test message.' }
					});
					yield* links.close;
				})
			)
	);

	it.live(
		'the shared status stream authorizes every snapshot and update without exposing another account',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, context, host, act } = yield* open();
					const opened: DriverOpen[] = [];
					const links = yield* host([fake('p', opened)]);
					const alice = t.member(['self'], { email: 'alice@ws.example' });
					const bob = t.member(['self'], { email: 'bob@ws.example' });
					const phones: string[] = [];
					for (const owner of [alice.id, bob.id])
						phones.push(
							present(
								ok(
									yield* act(t.as(t.admin).authority, 'sys_integration.create', {
										integration: 'whatsapp',
										name: owner,
										owner
									})
								).records[0]
							).id
						);
					const [alicePhone, bobPhone] = phones;
					if (alicePhone === undefined || bobPhone === undefined)
						throw new Error('Missing personal accounts');
					yield* links.pair(alicePhone, { key: 'alice-visible-account' });
					yield* links.pair(bobPhone, { key: 'bob-private-account' });
					const response = present(
						yield* verbs(
							context,
							links,
							t.as(alice).authority
						)(new Request('https://apex.example/__bolt/integrations/?stream=1'))
					);
					expect(response.status).toBe(200);
					const reader = present(response.body).getReader();
					const read = () =>
						Effect.tryPromise({ try: () => reader.read(), catch: Port.failure('link.stream') });
					yield* Effect.addFinalizer(() =>
						Effect.tryPromise({
							try: () => reader.cancel(),
							catch: Port.failure('link.stream')
						}).pipe(Effect.ignore)
					);
					let text = new TextDecoder().decode((yield* read()).value);
					expect(text).toContain('alice-visible-account');
					const aliceContext = opened.find((ctx) => ctx.instance === alicePhone);
					const bobContext = opened.find((ctx) => ctx.instance === bobPhone);
					if (aliceContext === undefined || bobContext === undefined)
						throw new Error('Missing provider contexts');
					yield* driverCall(() =>
						bobContext.status({
							state: 'pairing',
							account: 'bob-private-update',
							about: { address: 'bob-private@example.test' }
						})
					);
					yield* driverCall(() =>
						aliceContext.status({ state: 'pairing', account: 'alice-visible-update' })
					);
					text += new TextDecoder().decode((yield* read()).value);
					expect(text).toContain('alice-visible-update');
					expect(text).not.toContain('bob-private');
					expect(text).not.toContain(bobPhone);
					yield* links.close;
				})
			)
	);

	it.live(
		'a test is offered once connected: to the typed handle, or to the connected account itself; the provider’s own round trip when it has one',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, context, host } = yield* open();
					const sent: Json[] = [];
					const testing = (id: string, to: boolean): Provider => {
						const base = fake(id);
						return {
							...base,
							test: to ? { to: { name: 'to', label: { en: 'Send to', zh: '发送至' } } } : {},
							async open(ctx) {
								const l = await base.open(ctx);
								return {
									...l,
									async send(m) {
										sent.push(m);
										return { providerId: 't1' };
									}
								};
							}
						};
					};
					const links = yield* host([testing('twilio', true), testing('baileys', false)]);
					const h = verbs(context, links, t.as(t.admin).authority);
					expect(present(yield* links.state('a')).test).toBeUndefined();
					expect(present(yield* call(h, 'a', 'test', { to: 'x' })).status).toBe(400);
					yield* links.pair('a', { provider: 'twilio', key: 'k1' });
					yield* links.pair('b', { provider: 'baileys', key: 'me@s.whatsapp.net' });
					expect(present(yield* links.state('a')).test).toEqual({
						to: { name: 'to', label: { en: 'Send to', zh: '发送至' } }
					});
					expect(yield* json(present(yield* call(h, 'a', 'test', {})))).toEqual({
						error: { code: 'invalidInput', message: 'name where the test message goes' }
					});
					expect(present(yield* call(h, 'a', 'test', { to: 'whatsapp:+6591111111' })).status).toBe(
						200
					);
					expect(present(yield* call(h, 'b', 'test', {})).status).toBe(200);
					expect(sent).toMatchObject([
						{ to: 'whatsapp:+6591111111', text: expect.stringContaining('Norbital test message') },
						{ to: 'me@s.whatsapp.net' }
					]);
					yield* links.close;
				})
			)
	);
});

describe('a change of the instance row', () => {
	it.live(
		'reopens the instance’s session link with the configuration just committed; a change of anything else does not',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const cal = {
						description: 'Calendars',
						driver: 'calendar',
						configuration: { calendars: { kind: 'text', many: true, default: [] } }
					} satisfies IntegrationSpec;
					let links: LinkManager | undefined;
					const current = () => {
						if (links === undefined) throw new Error('The manager has not opened');
						return links;
					};
					const drivers = Layer.succeed(Drivers, {
						available: true,
						send: (instance, message, attachments) =>
							Effect.suspend(() => current().port.send(instance, message, attachments)),
						typing: (instance, to) => Effect.suspend(() => current().port.typing(instance, to)),
						request: (instance, operation) =>
							Effect.suspend(() => current().port.request(instance, operation)),
						read: (instance, feed, partition, cursor) =>
							Effect.suspend(() => current().port.read(instance, feed, partition, cursor)),
						changed: (instance) => Effect.suspend(() => current().port.changed(instance))
					});
					const { t, host, row, act } = yield* open(
						{
							...manifest,
							integrations: { ...manifest.integrations, cal },
							connections: { ...manifest.connections, cal: { integration: 'cal' } }
						},
						drivers
					);
					const opened: DriverOpen[] = [],
						closed: Json[] = [];
					const google: Provider = {
						driver: 'calendar',
						id: 'google',
						label: 'Google',
						setup: { kind: 'none', steps: [] },
						async open(ctx) {
							opened.push(ctx);
							if ((await ctx.credentials.load()).has('token'))
								await ctx.status({ state: 'connected' });
							return {
								async pair() {
									await ctx.credentials.write(new Map([['token', 't']]));
									await ctx.status({ state: 'connected' });
								},
								async close() {
									closed.push(ctx.configuration);
								}
							};
						}
					};
					links = yield* host([google]);
					yield* links.pair('cal', {});
					const epoch = (yield* row('cal'))['epoch'];
					ok(
						yield* act(t.as(t.admin).authority, 'sys_integration.update', {
							target: 'cal',
							set: { configuration: { calendars: ['work'] } }
						})
					);
					yield* until(() => opened.length === 2);
					// the slot opened with its definition's default configuration, as any instance starts
					expect(opened.map((c) => c.configuration)).toEqual([
						{ calendars: [] },
						{ calendars: ['work'] }
					]);
					expect(closed).toEqual([{ calendars: [] }]);
					expect((yield* row('cal'))['epoch']).not.toBe(epoch);
					expect(yield* links.state('cal')).toMatchObject({
						state: 'connected',
						provider: 'google'
					});
					ok(
						yield* act(t.as(t.admin).authority, 'sys_integration.update', {
							target: 'cal',
							set: { name: 'Calendars' }
						})
					);
					yield* Effect.sleep('50 millis');
					expect(opened).toHaveLength(2);
					yield* links.close;
				})
			)
	);
});

describe('a pause, a resume and a delete', () => {
	it.live(
		'a pause closes the session link and keeps its credentials; a resume opens it, on a host that booted while it was paused too; a delete closes it',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const cal = {
						description: 'Calendars',
						driver: 'calendar',
						configuration: { calendars: { kind: 'text', many: true, default: [] } }
					} satisfies IntegrationSpec;
					let links: LinkManager | undefined;
					const current = () => {
						if (links === undefined) throw new Error('The manager has not opened');
						return links;
					};
					const drivers = Layer.succeed(Drivers, {
						available: true,
						send: (instance, message, attachments) =>
							Effect.suspend(() => current().port.send(instance, message, attachments)),
						typing: (instance, to) => Effect.suspend(() => current().port.typing(instance, to)),
						request: (instance, operation) =>
							Effect.suspend(() => current().port.request(instance, operation)),
						read: (instance, feed, partition, cursor) =>
							Effect.suspend(() => current().port.read(instance, feed, partition, cursor)),
						changed: (instance) => Effect.suspend(() => current().port.changed(instance))
					});
					const { t, host, sealed, act } = yield* open(
						{
							...manifest,
							integrations: { ...manifest.integrations, cal },
							connections: { ...manifest.connections, cal: { integration: 'cal' } }
						},
						drivers
					);
					const opened: string[] = [],
						closed: string[] = [];

					const google: Provider = {
						driver: 'calendar',
						id: 'google',
						label: 'Google',
						setup: { kind: 'none', steps: [] },
						async open(ctx) {
							opened.push(ctx.instance);
							if ((await ctx.credentials.load()).has('token'))
								await ctx.status({ state: 'connected' });
							return {
								async pair() {
									await ctx.credentials.write(new Map([['token', 't']]));
									await ctx.status({ state: 'connected' });
								},
								async read() {
									return { items: [], cursor: null, more: false };
								},
								async close() {
									closed.push(ctx.instance);
								}
							};
						}
					};
					links = yield* host([google]);
					yield* links.pair('cal', {});
					ok(
						yield* act(t.as(t.admin).authority, 'sys_integration.update', {
							target: 'cal',
							set: { active: false }
						})
					);
					yield* until(() => closed.length === 1);
					expect(yield* sealed('cal')).toEqual({ provider: 'google', token: 't' });
					expect(
						yield* links.port.read('cal', 'entries', '', null).pipe(Effect.flip)
					).toMatchObject({ message: expect.stringMatching(/not connected/) });
					yield* links.close;
					// a host that boots while the instance is paused opens nothing, until the resume
					links = yield* host([google]);
					yield* links.resume;
					expect(opened).toEqual(['cal']);
					ok(
						yield* act(t.as(t.admin).authority, 'sys_integration.update', {
							target: 'cal',
							set: { active: true }
						})
					);
					yield* until(() => opened.length === 2);
					expect(yield* links.state('cal')).toMatchObject({
						state: 'connected',
						provider: 'google'
					});
					expect(yield* links.port.read('cal', 'entries', '', null)).toMatchObject({ items: [] });
					const other = present(
						ok(
							yield* act(t.as(t.admin).authority, 'sys_integration.create', {
								integration: 'cal',
								name: 'Other calendar'
							})
						).records[0]
					).id;
					yield* links.pair(other, {});
					ok(yield* act(t.as(t.admin).authority, 'sys_integration.delete', { target: other }));
					yield* until(() => closed.length === 2);
					expect(closed).toEqual(['cal', other]);
					expect(yield* links.state('cal')).toMatchObject({ state: 'connected' });
					yield* links.close;
				})
			)
	);
});

describe('a provider that signs in with OAuth and tests itself (a mailbox)', () => {
	it.live(
		'shows the host’s one redirect URI, publishes the authorize URL, and the host callback reaches the link its state names',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { host } = yield* open();
					const tested: string[] = [],
						callbacks: string[] = [];
					let state = '';
					const mailbox: Provider = {
						driver: 'email',
						id: 'microsoft',
						label: 'Microsoft 365',
						test: {},
						setup: {
							kind: 'form',
							steps: [{ text: 'Register this redirect URI', copy: 'redirectUrl' }],
							fields: [
								{
									name: 'tracking',
									label: 'Open tracking',
									optional: true,
									options: [
										{ value: 'off', label: 'Off' },
										{ value: 'on', label: { en: 'On', zh: '开启' } }
									]
								}
							]
						},
						async open(ctx) {
							const report = (s: LinkStatus) => ctx.status(s);
							return {
								async send() {
									return { providerId: '<x@acme.example>' };
								},
								async pair() {
									state = ctx.state();
									ctx.pairing({
										kind: 'oauth',
										value: `https://login.example/authorize?state=${state}`,
										label: 'Sign in with Microsoft'
									});
									await report({ state: 'pairing' });
								},
								async webhook(req) {
									callbacks.push(req.url);
									await ctx.credentials.write(new Map([['token', { access: 'a', exp: 1 }]]));
									await report({ state: 'connected', account: 'ops@acme.example' });
									return new Response('ok');
								},
								async test() {
									tested.push(ctx.instance);
								},
								async close() {}
							};
						}
					};
					const links = yield* host([mailbox]);
					const REDIRECT = 'https://apex.example/acme/hooks/oauth/callback';
					expect(present(yield* links.state('mail')).about).toEqual({ redirectUrl: REDIRECT });
					// before any sign-in started, a callback reaches no link
					expect(
						(yield* links.callback(new Request(`${REDIRECT}?code=c&state=x.mail`))).status
					).toBe(400);
					yield* links.pair('mail', {});
					expect(state).toMatch(/^[\w-]{36}\.mail$/);
					const wire = present(
						decodeStatus(
							Schema.decodeUnknownSync(Schema.Json)(
								JSON.parse(JSON.stringify(yield* links.state('mail')))
							)
						)
					);
					expect(wire.pairing).toEqual({
						kind: 'oauth',
						value: `https://login.example/authorize?state=${state}`,
						label: 'Sign in with Microsoft'
					});
					expect(present(present(present(wire.providers)[0]).setup.steps[0]).copy).toBe(
						'redirectUrl'
					);
					expect(
						present(present(present(present(wire.providers)[0]).setup.fields)[0]).options
					).toEqual([
						{ value: 'off', label: 'Off' },
						{ value: 'on', label: { en: 'On', zh: '开启' } }
					]);
					// a state naming no live sign-in, or none at all, is refused without reaching a link
					for (const forged of ['nostate', 'x.a', 'x.unknown'])
						expect(
							(yield* links.callback(new Request(`${REDIRECT}?code=c&state=${forged}`))).status
						).toBe(400);
					const callback = `${REDIRECT}?code=c&state=${encodeURIComponent(state)}`;
					expect((yield* links.callback(new Request(callback))).status).toBe(200);
					expect(callbacks).toEqual([callback]);
					expect(yield* links.state('mail')).toMatchObject({
						state: 'connected',
						account: 'ops@acme.example',
						pairing: null
					});
					yield* links.test('mail', {});
					expect(tested).toEqual(['mail']);
					yield* links.close;
				})
			)
	);
});

describe('personal instances', () => {
	it.live(
		'offer only providers that import a personal account, in their own words; route and resume each independently',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					let { t, host, sealed, act } = yield* open();
					const alice = t.member([], { email: 'alice@ws.example' }),
						bob = t.member([], { email: 'bob@ws.example' });
					const mine = (owner: string, name: string) =>
						act(t.as(t.admin).authority, 'sys_integration.create', {
							integration: 'whatsapp',
							name,
							owner
						}).pipe(Effect.map((outcome) => present(ok(outcome).records[0]).id));
					const [alicePhone, bobPhone] = [
						yield* mine(alice.id, 'Alice'),
						yield* mine(bob.id, 'Bob')
					];
					const sender = fake('cloud', [], 'whatsapp', { personal: false });
					const importer = fake('web', [], 'whatsapp', {
						describe: ({ personal }) => ({
							label: personal ? 'Import account' : 'Send account',
							setup: { kind: 'qr', steps: [] }
						})
					});
					const links = yield* host([sender, importer]);
					expect(
						present(present(yield* links.state(alicePhone)).providers).map((p) => [p.id, p.label])
					).toEqual([['web', 'Import account']]);
					expect(
						present(present(yield* links.state('b')).providers).map((p) => [p.id, p.label])
					).toEqual([
						['cloud', 'Fake cloud'],
						['web', 'Send account']
					]);
					yield* links.pair(alicePhone, { key: 'alice' });
					yield* links.pair(bobPhone, { key: 'bob' });
					yield* links.close;
					const resumed = yield* host([sender, importer]);
					yield* resumed.resume;
					expect(yield* resumed.state(alicePhone)).toMatchObject({
						state: 'connected',
						account: 'alice',
						provider: 'web'
					});
					expect(present(yield* resumed.state(alicePhone)).test).toBeUndefined();
					yield* resumed.webhook(alicePhone, post({ ...chat('same'), direction: 'outbound' }));
					yield* resumed.webhook(bobPhone, post(chat('same')));
					const [rows] = yield* t.db.read([
						{
							text: `SELECT m.integration, m.origin, u.email FROM sys_message m JOIN sys_integration i ON i.id = m.integration
			JOIN sys_user u ON u.id = i.owner ORDER BY u.email`,
							params: []
						}
					]);
					expect(present(rows).rows).toEqual([
						{ integration: alicePhone, origin: 'sync', email: 'alice@ws.example' },
						{ integration: bobPhone, origin: 'sync', email: 'bob@ws.example' }
					]);
					yield* resumed.unpair(alicePhone);
					expect(yield* resumed.state(bobPhone)).toMatchObject({
						state: 'connected',
						account: 'bob'
					});
					expect(yield* sealed(alicePhone)).toEqual({});
					yield* resumed.close;
				})
			)
	);
});

describe('one per member, and the host’s OAuth client', () => {
	it.live(
		'a member owns at most one instance of a definition; workspace instances are not counted',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, act } = yield* open();
					const alice = t.member([], { email: 'alice@ws.example' }),
						bob = t.member([], { email: 'bob@ws.example' });
					const create = (input: { [key: string]: Json }) =>
						act(t.as(t.admin).authority, 'sys_integration.create', {
							integration: 'whatsapp',
							...input
						});
					ok(yield* create({ name: 'Alice', owner: alice.id }));
					expect(yield* create({ name: 'Alice again', owner: alice.id })).toMatchObject({
						kind: 'refused',
						code: 'unique'
					});
					ok(yield* create({ name: 'Bob', owner: bob.id }));
					ok(yield* create({ name: 'Alice mail', owner: alice.id, integration: 'email' }));
					// `a` and `b` are already workspace WhatsApp instances: another is still allowed
					ok(yield* create({ name: 'Desk' }));
				})
			)
	);

	it.live(
		'offers every definition with its providers; a Google sign-in is unavailable until the host or the definition has a client',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { host } = yield* open({
						...manifest,
						integrations: {
							...manifest.integrations,
							diary: {
								description: 'A calendar',
								driver: 'calendar',
								oauth: { client: 'DIARY_ID', secret: 'DIARY_SECRET' }
							}
						}
					});
					const opened: DriverOpen[] = [];
					const gmail = fake('gmail', opened, 'email', {
						oauth: 'google',
						setup: { kind: 'oauth', steps: [] }
					});
					const calendar = fake('google', opened, 'calendar', { oauth: 'google' });
					const offerOf = <O extends { integration: string }>(offers: readonly O[], name: string) =>
						present(offers.find((o) => o.integration === name));
					const bare = yield* host([gmail, calendar]);
					const before = yield* bare.offers;
					expect(offerOf(before, 'email')).toMatchObject({
						driver: 'email',
						conversation: true,
						personal: [{ id: 'gmail', available: false }],
						workspace: [{ id: 'gmail', available: false }]
					});
					expect(offerOf(before, 'diary')).toMatchObject({
						personal: [{ id: 'google', available: false }]
					});
					expect(offerOf(before, 'erp')).toMatchObject({ personal: [], workspace: [] });
					yield* bare.close;

					// the host's client signs in every definition that names none set
					const hosted = yield* host([gmail, calendar], {
						oauth: { google: { id: 'host-id', secret: 'host-secret' } }
					});
					const after = yield* hosted.offers;
					expect(present(offerOf(after, 'email').personal[0]).available).toBeUndefined();
					yield* hosted.pair('mail', { key: 'k' });
					expect(present(opened.at(-1)).oauthClient('google')).toEqual({
						id: 'host-id',
						secret: 'host-secret'
					});
					yield* hosted.close;

					// a definition's own client, once its secrets are set, wins over the host's
					const own = yield* host([gmail, calendar], {
						oauth: { google: { id: 'host-id', secret: 'host-secret' } },
						secrets: { DIARY_ID: 'own-id', DIARY_SECRET: 'own-secret' }
					});
					expect(
						present(offerOf(yield* own.offers, 'diary').personal[0]).available
					).toBeUndefined();
					yield* own.close;
				})
			)
	);
});

it('the OAuth client a link grants with: the definition’s own when both secrets are set, else the host’s', () => {
	const host = { google: { id: 'host-id', secret: 'host-secret' } };
	const declared = { oauth: { client: 'ID', secret: 'SECRET' } };
	expect(oauthClientOf({}, {}, host, 'google')).toEqual(host.google);
	expect(oauthClientOf(declared, { ID: 'own', SECRET: 'shh' }, host, 'google')).toEqual({
		id: 'own',
		secret: 'shh'
	});
	expect(oauthClientOf(declared, { ID: 'own' }, host, 'google')).toEqual(host.google);
	expect(oauthClientOf(declared, { ID: 'own', SECRET: '' }, undefined, 'google')).toBeUndefined();
});

describe('source import boundaries', () => {
	it.live(
		'freezes a selected start before pairing and applies a new boundary without losing credentials',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, host, sealed } = yield* open();
					const opened: DriverOpen[] = [];
					const links = yield* host([
						fake('p', opened, 'whatsapp', {
							importStart: { kind: 'timestamp', precision: 'second' }
						})
					]);
					const admin = t.as(t.admin).authority;
					yield* links.pair(
						'a',
						{ key: 'k', importStart: { kind: 'since', date: '2026-10-21', zone: 'Asia/Seoul' } },
						admin
					);
					const first = present(opened[0]);
					expect(first.importStart).toEqual({
						kind: 'since',
						at: '2026-10-20T15:00:00.000Z',
						zone: 'Asia/Seoul',
						origin: 'date'
					});
					yield* driverCall(() => first.credentials.write(new Map([['state', { uid: 42 }]])));
					const stored = yield* sealed('a');
					const before = Date.now();
					yield* links.importStart('a', { kind: 'now', zone: 'Asia/Seoul' }, admin);
					const after = Date.now();
					expect(opened).toHaveLength(2);
					const applied = present(opened[1]).importStart;
					if (applied?.kind !== 'since') throw new Error('Expected frozen timestamp start');
					expect(Date.parse(applied.at)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
					expect(Date.parse(applied.at)).toBeLessThanOrEqual(Math.floor(after / 1000) * 1000);
					expect(applied.at.endsWith('.000Z')).toBe(true);
					expect(applied.origin).toBe('now');
					expect(first.signal.aborted).toBe(true);
					expect(yield* sealed('a')).toEqual(stored);
					expect(
						yield* driverCall(() =>
							first.emit({ kind: 'messages', messages: [chat('stale-opening')] })
						).pipe(Effect.flip)
					).toMatchObject({ code: 'sourceChanged' });
					expect(yield* links.state('a')).toMatchObject({
						state: 'connected',
						account: 'k',
						importStart: applied
					});
					yield* links.close;
					const resumed: DriverOpen[] = [];
					const next = yield* host([
						fake('p', resumed, 'whatsapp', {
							importStart: { kind: 'timestamp', precision: 'second' }
						})
					]);
					yield* next.resume;
					expect(present(resumed[0]).importStart).toEqual(applied);
					expect(yield* sealed('a')).toEqual(stored);
					yield* next.close;
				})
			)
	);

	it.live('native positions require the selected provider declaration and validator', () =>
		Effect.scoped(
			Effect.gen(function* () {
				const { t, host, sealed } = yield* open();
				const opened: DriverOpen[] = [];
				const links = yield* host([
					fake('native', opened, 'whatsapp', {
						importStart: { kind: 'native', fields: [{ name: 'cursor', label: 'Cursor' }] },
						validateImportStart: async (values) => ({ cursor: values['cursor']?.trim() ?? '' })
					})
				]);
				yield* links.pair('a', { key: 'k' });
				const admin = t.as(t.admin).authority,
					original = yield* sealed('a');
				expect(
					yield* links
						.importStart('a', { kind: 'native', provider: 'other', values: { cursor: '1' } }, admin)
						.pipe(Effect.flip)
				).toMatchObject({ code: 'unavailable' });
				expect(
					yield* links
						.importStart(
							'a',
							{ kind: 'native', provider: 'native', values: { password: 'not-a-position' } },
							admin
						)
						.pipe(Effect.flip)
				).toMatchObject({ code: 'invalidInput' });
				yield* links.importStart(
					'a',
					{ kind: 'native', provider: 'native', values: { cursor: ' opaque:42 ' } },
					admin
				);
				expect(present(opened[1]).importStart).toMatchObject({
					kind: 'native',
					provider: 'native',
					values: { cursor: 'opaque:42' },
					selectedAt: expect.any(String)
				});
				expect(yield* sealed('a')).toEqual(original);
				yield* links.close;
				const unsupported = yield* host([
					fake('unsupported', [], 'whatsapp', {
						importStart: { kind: 'native', fields: [{ name: 'cursor', label: 'Cursor' }] }
					})
				]);
				yield* unsupported.pair('b', { key: 'k' });
				expect(
					yield* unsupported.importStart('b', { kind: 'now', zone: 'UTC' }, admin).pipe(Effect.flip)
				).toMatchObject({ code: 'unavailable' });
				expect(
					yield* unsupported
						.importStart(
							'b',
							{ kind: 'native', provider: 'unsupported', values: { cursor: '1' } },
							admin
						)
						.pipe(Effect.flip)
				).toMatchObject({ code: 'unavailable' });
				yield* unsupported.close;
			})
		)
	);

	it.live(
		'a name-only grant cannot change source boundaries and raw updates reject malformed instants',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, host, act } = yield* open({
						...manifest,
						policies: {
							...manifest.policies,
							names: {
								description: 'Names only',
								grants: {
									sys_integration: {
										read: true,
										update: { where: { owner: { eq: { actor: 'id' } } }, fields: ['name'] }
									}
								}
							}
						}
					});
					const alice = t.member(['names'], { email: 'names@ws.example' }),
						admin = t.as(t.admin).authority;
					const instance = present(
						ok(
							yield* act(admin, 'sys_integration.create', {
								integration: 'whatsapp',
								name: 'Owned phone',
								owner: alice.id
							})
						).records[0]
					).id;
					const links = yield* host([
						fake('p', [], 'whatsapp', { importStart: { kind: 'timestamp' } })
					]);
					expect(yield* links.may(t.as(alice).authority, instance)).toBe(true);
					expect(
						yield* links
							.importStart(instance, { kind: 'all' }, t.as(alice).authority)
							.pipe(Effect.flip)
					).toMatchObject({ code: 'forbidden' });
					for (const start of [
						{ kind: 'since', at: '2026-10-21', zone: 'UTC', origin: 'date' },
						{ kind: 'native', provider: 'p', values: { cursor: '1' }, selectedAt: '2026-10-21' }
					])
						expect(
							yield* act(admin, 'sys_integration.update', {
								target: instance,
								set: { import_start: start }
							})
						).toMatchObject({ kind: 'refused', field: 'import_start' });
					expect(yield* links.state(instance)).toMatchObject({ importStart: null });
					yield* links.close;
				})
			)
	);
});
