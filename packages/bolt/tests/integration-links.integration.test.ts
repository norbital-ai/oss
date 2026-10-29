// engine/integrations/links.ts on PGlite (§4.5): the host half every host shares — one link per instance from the
// provider the operator paired it through, credentials sealed per instance under the opener's epoch, resume from the
// instance rows, per-instance webhooks under the workspace's public path, durable status only on durable transitions,
// a second opener fencing the first for good, credential writes retried until they land, concurrent request links, and
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
	Schema,
	Stream
} from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Drivers } from '../src/engine/ports.ts';
import { loopbackTcpPort } from '../src/node/tcp.ts';
import { actReply, json, routeFixture } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from '@effect/vitest';
import type { DriverName, IntegrationSpec } from '../src/decl/runtime/integration.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { DbError, Fenced } from '../src/engine/errors.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { credentials, type Credentials } from '../src/engine/integrations/credentials.ts';
import {
	oauthClientOf,
	type DriverOpen,
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
import { IntegrationManager, integrationRoutes } from '../src/protocol/integrations.ts';
import { SessionAuthority } from '../src/protocol/http.ts';
import {
	layer,
	TestWorkspace,
	type Kit,
	type TestOptions,
	type WorkspaceServices
} from '../../bolt-cli/src/test/index.ts';
import { until as untilTurned } from './support/turns.ts';

const present = <A>(value: A | null | undefined): A => {
	if (value === null || value === undefined) throw new Error('Missing fixture value');
	return value;
};

const cal = {
	description: 'Calendars',
	driver: 'calendar',
	configuration: { calendars: { kind: 'text', many: true, default: [] } }
} satisfies IntegrationSpec;
/** The calendar case's open manager: the workspace's Drivers port answers through it, as a host's does. */
let calLinks: LinkManager | undefined;
const current = () => {
	if (calLinks === undefined) throw new Error('The manager has not opened');
	return calLinks;
};
const calDrivers = Layer.succeed(Drivers, {
	available: true,
	send: (instance, message, attachments) =>
		Effect.suspend(() => current().port.send(instance, message, attachments)),
	typing: (instance, to, on) => Effect.suspend(() => current().port.typing(instance, to, on)),
	request: (instance, operation) =>
		Effect.suspend(() => current().port.request(instance, operation)),
	read: (instance, feed, partition, cursor) =>
		Effect.suspend(() => current().port.read(instance, feed, partition, cursor)),
	// cases before the calendar one open their own managers: a row change reaches none until it opens
	changed: (instance) =>
		Effect.suspend(() => (calLinks === undefined ? Effect.void : calLinks.port.changed(instance)))
});
const PUBLIC = 'https://apex.example/acme';
const manifest = {
	workspace: { tz: 'UTC', locale: 'en' },
	models: {},
	relationships: {},
	exposures: {},
	integrations: {
		erp: {
			description: 'The ERP',
			driver: 'http',
			credential: { apiKey: { kind: 'text', label: 'API key' } },
			http: {
				baseUrl: 'https://erp.example/api',
				auth: { header: { name: 'x-api-key', value: 'apiKey' } }
			}
		},
		cal
	},
	// one slot per case: the cases share one workspace, and none reads another's instance
	connections: {
		a: { integration: 'whatsapp' },
		a1: { integration: 'whatsapp' },
		b1: { integration: 'whatsapp' },
		a2: { integration: 'whatsapp' },
		a4: { integration: 'whatsapp' },
		b4: { integration: 'whatsapp' },
		a7: { integration: 'whatsapp' },
		a8: { integration: 'whatsapp' },
		a10: { integration: 'whatsapp' },
		a24: { integration: 'whatsapp' },
		mail: { integration: 'email' },
		tg: { integration: 'telegram' },
		erp9: { integration: 'erp' },
		cal2: { integration: 'cal' }
	},
	policies: {
		self: {
			description: 'Manages their own accounts',
			grants: {
				sys_integration: { read: true, update: { check: true } }
			}
		}
	},
	teams: {},
	automations: {},
	envoys: {},
	mcp: {},
	apps: {},
	customFields: {},
	agent: { skills: {} },
	needs: []
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
/** `self` changes only the accounts they own: one check over the batch, the stored owner against the actor. */
const OWNED = `function* own(changes, ctx) {
	const row = changes.findIndex((c) => c.before.owner !== ctx.actor.id);
	return row >= 0 ? ctx.deny('Only your own accounts change.', { row }) : ctx.allow();
}
export default { policy: {
	self: { grants: { sys_integration: { update: { check: own } } } }
} };`;
const open = (m: EngineManifest = manifest, ports?: TestOptions<Drivers>['ports']) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: m,
				guest: yield* program(OWNED),
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
				admit: (effect) => effect.pipe(Effect.provide(context)),
				credentials: store,
				publicUrl: PUBLIC,
				tcp: loopbackTcpPort,
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
const until = (done: () => boolean) => untilTurned(Effect.sync(done));
/** One workspace for the file's cases; a case needing another manifest opens its own. */
class Fixture extends Context.Service<Fixture, Effect.Success<ReturnType<typeof open>>>()(
	'test/IntegrationLinksFixture'
) {}

/** The suite's workspace runs on the real clock, as `it.live` would. */
const LIVE = { excludeTestServices: true };
layer(Layer.effect(Fixture, open(manifest, calDrivers)), LIVE)('integration links', (it) => {
	describe('instance links', () => {
		it.effect(
			'a driver with two providers asks which; each instance pairs, seals and sends through its own',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { host, sealed } = yield* Fixture;
						const links = yield* host([fake('twilio'), fake('baileys')]);
						expect(yield* links.pair('a1', { key: 'k1' }).pipe(Effect.flip)).toMatchObject({
							message: expect.stringMatching(/choose how to connect.*twilio, baileys/)
						});
						yield* links.pair('a1', { provider: 'twilio', key: 'k1' });
						yield* links.pair('b1', { provider: 'baileys', key: 'k2' });
						expect(yield* sealed('a1')).toEqual({ provider: 'twilio', credential: { key: 'k1' } });
						expect(yield* links.state('a1')).toMatchObject({
							instance: 'a1',
							integration: 'whatsapp',
							driver: 'whatsapp',
							state: 'connected',
							provider: 'twilio',
							account: 'k1',
							stored: true,
							about: { webhookUrl: 'https://apex.example/acme/hooks/integration/a1' }
						});
						expect(present(present(yield* links.state('a1')).providers).map((p) => p.id)).toEqual([
							'twilio',
							'baileys'
						]);
						expect(yield* links.port.send('a1', { text: 'x' }, [])).toEqual({
							providerId: 'twilio:a1:x'
						});
						expect(yield* links.port.send('b1', { text: 'y' }, [])).toEqual({
							providerId: 'baileys:b1:y'
						});
						expect(yield* links.port.send('tg', { text: 'z' }, []).pipe(Effect.flip)).toMatchObject(
							{
								message: expect.stringMatching(/not connected/)
							}
						);
						yield* links.close;
					})
				)
		);

		it.effect(
			'a refused pairing keeps nothing; unpair destroys the credentials and records the instance unpaired',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { host, sealed, row } = yield* Fixture;
						const links = yield* host([fake('twilio')]);
						expect(yield* links.pair('a2', {}).pipe(Effect.flip)).toMatchObject({
							message: expect.stringMatching(/key is required/)
						});
						expect(yield* sealed('a2')).toEqual({});
						expect(present(yield* links.state('a2')).state).toBe('unpaired');
						yield* links.pair('a2', { key: 'k' });
						expect((yield* row('a2'))['status']).toMatchObject({
							state: 'connected',
							account: 'k'
						});
						yield* links.unpair('a2');
						expect(yield* sealed('a2')).toEqual({});
						expect((yield* row('a2'))['status']).toMatchObject({
							state: 'unpaired',
							account: null
						});
						expect(yield* links.state('a2')).toMatchObject({ state: 'unpaired', stored: false });
						expect(yield* links.port.send('a2', { text: 'x' }, []).pipe(Effect.flip)).toMatchObject(
							{
								message: expect.stringMatching(/not connected/)
							}
						);
						yield* links.close;
					})
				)
		);

		it.effect(
			'resume opens only instances that store a registered provider; the webhook routes by instance and resolves after the engine committed',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, store, host } = yield* Fixture;
						const first = yield* host([fake('baileys4')]);
						yield* first.pair('b4', { key: 'k2' });
						yield* first.close;
						// one sealed for a provider this host does not register (a paused one: the pause case)
						const o = yield* store.open('a4');
						yield* store.write(
							'a4',
							o.epoch,
							new Map<string, Json>([
								['provider', 'gone'],
								['credential', { key: 'x' }]
							])
						);
						const resumedWith: DriverOpen[] = [];
						const links = yield* host([fake('baileys4', resumedWith), fake('twilio4')]);
						yield* links.resume;
						expect(resumedWith.map((c) => [c.instance, c.personal, c.webhookUrl])).toEqual([
							['b4', false, 'https://apex.example/acme/hooks/integration/b4']
						]);
						expect((yield* links.webhook('b4', post(chat('W1')))).status).toBe(200);
						// the answer came after the ingest committed
						const [m] = yield* t.db.read([
							{
								text: `SELECT integration, provider_id FROM sys_message WHERE direction = 'inbound' AND integration = 'b4'`,
								params: []
							}
						]);
						expect(present(m).rows).toEqual([{ integration: 'b4', provider_id: 'W1' }]);
						expect((yield* links.webhook('a4', post(chat('W2')))).status).toBe(404);
						yield* links.close;
					})
				)
		);
	});

	describe('durable status and the epoch fence', () => {
		it.effect(
			'lands a durable transition on the row once; a reconnect stays in memory and on the stream',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { host, row } = yield* Fixture;
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
						yield* links.pair('a7', {});
						const seen: InstanceStatus[] = [];
						const watched = yield* Queue.unbounded<InstanceStatus>();
						const watch = yield* links.watch('a7').pipe(
							Stream.runForEach((status) =>
								Effect.gen(function* () {
									seen.push(status);
									yield* Queue.offer(watched, status);
								})
							),
							Effect.forkScoped
						);
						expect((yield* Queue.take(watched)).state).toBe('connected');
						const at = (yield* row('a7'))['revision'];
						expect((yield* row('a7'))['status']).toMatchObject({
							state: 'connected',
							account: '+65 1'
						});
						yield* driverCall(() =>
							present(ctx).status({ state: 'reconnecting', detail: 'the socket dropped' })
						);
						expect((yield* row('a7'))['revision']).toBe(at);
						expect(present(yield* links.state('a7')).state).toBe('reconnecting');
						yield* driverCall(() => present(ctx).status({ state: 'connected', account: '+65 1' }));
						expect((yield* row('a7'))['revision']).toBe(at);
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
						expect((yield* row('a7'))['status']).toMatchObject({
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

		it.effect(
			'a second opener fences the first: its next credential write stops it for good as replaced, with no reconnect',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { host, sealed, row } = yield* Fixture;
						const firstOpened: DriverOpen[] = [],
							secondOpened: DriverOpen[] = [];
						const first = yield* host([fake('p8', firstOpened)]),
							second = yield* host([fake('p8', secondOpened)]);
						yield* first.pair('a8', { key: 'k1' });
						const epoch = (yield* row('a8'))['epoch'];
						yield* second.resume;
						expect(secondOpened).toHaveLength(1);
						expect((yield* row('a8'))['epoch']).not.toBe(epoch);
						expect(
							yield* driverCall(() =>
								present(firstOpened[0]).credentials.write(new Map([['state', { n: 1 }]]))
							).pipe(Effect.flip)
						).toMatchObject({ _tag: 'Fenced' });
						expect(present(firstOpened[0]).signal.aborted).toBe(true);
						expect(yield* first.state('a8')).toMatchObject({ state: 'error', code: 'replaced' });
						expect(
							yield* driverCall(() =>
								present(firstOpened[0]).credentials.write(new Map([['state', { n: 2 }]]))
							).pipe(Effect.flip)
						).toMatchObject({ _tag: 'Fenced' });
						yield* driverCall(() => present(firstOpened[0]).status({ state: 'connected' }));
						expect(yield* first.state('a8')).toMatchObject({ state: 'error', code: 'replaced' });
						expect(yield* first.port.send('a8', { text: 'x' }, []).pipe(Effect.flip)).toMatchObject(
							{
								_tag: 'Fenced'
							}
						);
						expect(
							yield* driverCall(() =>
								present(firstOpened[0]).emit({ kind: 'messages', messages: [chat('W1')] })
							).pipe(Effect.flip)
						).toMatchObject({ _tag: 'Fenced' });
						yield* first.resume;
						expect(firstOpened).toHaveLength(1); // no reconnect
						expect(yield* sealed('a8')).toEqual({ provider: 'p8', credential: { key: 'k1' } });
						expect(yield* second.port.send('a8', { text: 'y' }, [])).toEqual({
							providerId: 'p8:a8:y'
						});
						yield* first.close;
						yield* second.close;
					})
				)
		);

		it.effect(
			'two calls of a request link that read the same credentials: the second to write is fenced and changes nothing',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { host, sealed } = yield* Fixture;
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
						yield* links.pair('erp9', { apiKey: 'k' });
						const calls = yield* Effect.all(
							[links.port.request('erp9', 'first'), links.port.request('erp9', 'second')],
							{ concurrency: 'unbounded', mode: 'result' }
						);
						expect(
							calls.map((result) => (Result.isSuccess(result) ? 'fulfilled' : 'rejected')).sort()
						).toEqual(['fulfilled', 'rejected']);
						expect(calls.find(Result.isFailure)).toMatchObject({ failure: { _tag: 'Fenced' } });
						const successful = calls.find(Result.isSuccess);
						if (successful === undefined) throw new Error('Missing winning request');
						const won = successful.success;
						expect(yield* sealed('erp9')).toEqual({
							provider: 'http',
							credential: { apiKey: 'k' },
							token: won
						});
						// the losing call replaced nothing: the instance still answers
						expect(yield* links.port.request('erp9', 'third')).toBe('third');
						yield* links.close;
					})
				)
		);

		it.effect('retries a failed credential write until it lands; it is never shed', () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { store, host, sealed } = yield* Fixture;
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
					yield* links.pair('a10', { key: 'k1' });
					failures = 2;
					yield* driverCall(() =>
						present(opened[0]).credentials.write(new Map([['state', { cursor: 7 }]]))
					);
					expect(failures).toBe(-1);
					expect(yield* sealed('a10')).toMatchObject({ state: { cursor: 7 } });
					yield* links.close;
				})
			)
		);
	});

	describe('the instance verbs', () => {
		const member = (t: Kit, policies: readonly string[], over = {}) =>
			t.as(t.member(policies, over)).authority;
		/** The verb routes over one manager; `as` names the session's authority for the next request. */
		const verbs = (
			workspace: Context.Context<TestWorkspace | WorkspaceServices>,
			links: LinkManager
		) => {
			let who: Authority | null = null;
			const handle = (request: Request) =>
				integrationRoutes(HttpServerRequest.fromWeb(request)).pipe(
					Effect.provideService(IntegrationManager, Option.some(links)),
					Effect.provideService(SessionAuthority, {
						of: () => Effect.sync(() => Option.fromNullishOr(who))
					}),
					Effect.provide(workspace),
					Effect.map((response) =>
						Option.isSome(response) ? HttpServerResponse.toWeb(response.value) : null
					)
				);
			return (authority: Authority | null) => {
				who = authority;
				return handle;
			};
		};
		// a host routes the verbs with the workspace's path prefix stripped
		const url = (instance: string, verb = '') =>
			`https://apex.example/__bolt/integrations/${encodeURIComponent(instance)}${verb === '' ? '' : `/${verb}`}`;
		const call = (
			h: ReturnType<ReturnType<typeof verbs>>,
			instance: string,
			verb = '',
			body?: Json
		) =>
			h(
				new Request(
					url(instance, verb),
					body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }
				)
			);

		it.effect(
			'authorize as "may update this row": the owner and an administrator, never another member, an external one or a visitor',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, context, host, sealed, act } = yield* Fixture;
						const links = yield* host([fake('p')]);
						const as = verbs(context, links);
						const alice = t.member(['self'], { email: 'alice13@ws.example' });
						const phone = present(
							ok(
								yield* act(t.as(t.admin).authority, 'sys_integration.create', [
									{
										integration: 'whatsapp',
										name: 'Alice’s phone',
										owner: alice.id
									}
								])
							).records[0]
						).id;
						expect(present(yield* call(as(null), phone)).status).toBe(401);
						expect(
							present(yield* call(as(member(t, ['self'])), phone, 'pair', { key: 'x' })).status
						).toBe(403);
						expect(
							present(yield* call(as(member(t, ['self'], { external: true })), phone)).status
						).toBe(403);
						expect(present(yield* call(as(t.as(alice).authority), 'a')).status).toBe(403); // a workspace instance is not hers
						expect(yield* sealed(phone)).toEqual({});
						expect(
							present(
								yield* call(as(t.as(alice).authority), phone, 'pair', {
									key: 'mine'
								})
							).status
						).toBe(200);
						expect(present(yield* call(as(t.as(t.admin).authority), phone)).status).toBe(200);
						// a personal account sends no test message
						expect(
							yield* json(present(yield* call(as(t.as(alice).authority), phone, 'test', {})))
						).toEqual({
							error: { code: 'invalidInput', message: 'A personal account sends no test message.' }
						});
						yield* links.close;
					})
				)
		);
	});

	describe('a provider that signs in with OAuth and tests itself (a mailbox)', () => {
		it.effect(
			'shows the host’s one redirect URI, publishes the authorize URL, and the host callback reaches the link its state names',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { host } = yield* Fixture;
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
										state = await ctx.state();
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

	describe('source import boundaries', () => {
		it.effect(
			'freezes a selected start before pairing and applies a new boundary without losing credentials',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, host, sealed } = yield* Fixture;
						const opened: DriverOpen[] = [];
						const links = yield* host([
							fake('pi', opened, 'whatsapp', {
								importStart: { kind: 'timestamp', precision: 'second' }
							})
						]);
						const admin = t.as(t.admin).authority;
						yield* links.pair(
							'a24',
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
						const stored = yield* sealed('a24');
						const before = Date.now();
						yield* links.importStart('a24', { kind: 'now', zone: 'Asia/Seoul' }, admin);
						const after = Date.now();
						expect(opened).toHaveLength(2);
						const applied = present(opened[1]).importStart;
						if (applied?.kind !== 'since') throw new Error('Expected frozen timestamp start');
						expect(Date.parse(applied.at)).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
						expect(Date.parse(applied.at)).toBeLessThanOrEqual(Math.floor(after / 1000) * 1000);
						expect(applied.at.endsWith('.000Z')).toBe(true);
						expect(applied.origin).toBe('now');
						expect(first.signal.aborted).toBe(true);
						expect(yield* sealed('a24')).toEqual(stored);
						expect(
							yield* driverCall(() =>
								first.emit({ kind: 'messages', messages: [chat('stale-opening')] })
							).pipe(Effect.flip)
						).toMatchObject({ code: 'sourceChanged' });
						expect(yield* links.state('a24')).toMatchObject({
							state: 'connected',
							account: 'k',
							importStart: applied
						});
						yield* links.close;
						const resumed: DriverOpen[] = [];
						const next = yield* host([
							fake('pi', resumed, 'whatsapp', {
								importStart: { kind: 'timestamp', precision: 'second' }
							})
						]);
						yield* next.resume;
						expect(present(resumed[0]).importStart).toEqual(applied);
						expect(yield* sealed('a24')).toEqual(stored);
						yield* next.close;
					})
				)
		);
	});
	describe('a pause, a resume and a delete', () => {
		it.effect(
			'a pause closes the session link and keeps its credentials; a resume opens it, on a host that booted while it was paused too; a delete closes it',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, host, sealed, act } = yield* Fixture;
						let links: LinkManager | undefined;
						const opened: string[] = [],
							closed: string[] = [];

						const google: Provider = {
							driver: 'calendar',
							id: 'google2',
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
						links = calLinks = yield* host([google]);
						yield* links.pair('cal2', {});
						ok(
							yield* act(t.as(t.admin).authority, 'sys_integration.update', [
								{
									target: 'cal2',
									set: { active: false }
								}
							])
						);
						yield* until(() => closed.length === 1);
						expect(yield* sealed('cal2')).toEqual({ provider: 'google2', token: 't' });
						expect(
							yield* links.port.read('cal2', 'entries', '', null).pipe(Effect.flip)
						).toMatchObject({ message: expect.stringMatching(/not connected/) });
						yield* links.close;
						// a host that boots while the instance is paused opens nothing, until the resume
						links = calLinks = yield* host([google]);
						yield* links.resume;
						expect(opened).toEqual(['cal2']);
						ok(
							yield* act(t.as(t.admin).authority, 'sys_integration.update', [
								{
									target: 'cal2',
									set: { active: true }
								}
							])
						);
						yield* until(() => opened.length === 2);
						expect(yield* links.state('cal2')).toMatchObject({
							state: 'connected',
							provider: 'google2'
						});
						expect(yield* links.port.read('cal2', 'entries', '', null)).toMatchObject({
							items: []
						});
						const other = present(
							ok(
								yield* act(t.as(t.admin).authority, 'sys_integration.create', [
									{
										integration: 'cal',
										name: 'Other calendar'
									}
								])
							).records[0]
						).id;
						yield* links.pair(other, {});
						ok(yield* act(t.as(t.admin).authority, 'sys_integration.delete', [{ target: other }]));
						yield* until(() => closed.length === 2);
						expect(closed).toEqual(['cal2', other]);
						expect(yield* links.state('cal2')).toMatchObject({ state: 'connected' });
						yield* links.close;
					})
				)
		);
	});
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
