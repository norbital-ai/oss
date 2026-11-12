// engine/integrations/links.ts on PGlite (§4.5): the host half every host shares — one link per instance from the
// provider the operator paired it through, credentials sealed per instance under the opener's epoch, resume from the
// instance rows, per-instance webhooks under the workspace's public path, durable status only on durable transitions,
// a second opener fencing the first for good, bounded credential-write retries, concurrent request links, and
// the instance verbs (`/__bolt/integrations/<instance>/…`) authorized as "may update this row".
import * as NodeCrypto from '@effect/platform-node/NodeCrypto';
import {
	Clock,
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
	Scope,
	Stream
} from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import { Drivers } from '../src/engine/ports.ts';
import { loopback_tcp_port } from '../src/node/tcp.ts';
import { act_reply, json, route_fixture } from './support/route-fixture.ts';
import { program } from '../../bolt-cli/src/test/guest.ts';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from '@effect/vitest';
import type { DriverName, IntegrationSpec } from '../src/decl/runtime/integration.ts';
import type { Json } from '../src/decl/values.ts';
import type { Authority, ActOutcome as Outcome } from '../src/engine/contracts.ts';
import type { EngineManifest } from '../src/engine/manifest.ts';
import { Unavailable } from '../src/decl/errors.ts';
import { DbError, Fenced } from '../src/engine/errors.ts';
import { LINK_DOWN } from '../src/engine/integrations/abi.ts';
import { Conversations, Outbound } from '../src/engine/services.ts';
import { BoltError } from '../src/protocol/errors.ts';
import { credentials, type Credentials } from '../src/engine/integrations/credentials.ts';
import {
	oauth_client_of,
	type DriverOpen,
	type Link,
	type Provider
} from '../src/engine/integrations/driver.ts';
import {
	decode_status,
	type InstanceStatus,
	type LinkStatus
} from '../src/protocol/instance-status.ts';
import {
	integration_links,
	type LinkManager,
	type LinksHost
} from '../src/engine/integrations/links.ts';
import { Secrets } from '../src/engine/secrets.ts';
import { IntegrationManager, integration_routes } from '../src/protocol/integrations.ts';
import { SessionAuthority } from '../src/protocol/http.ts';
import {
	layer,
	TestWorkspace,
	type Kit,
	type TestOptions,
	type WorkspaceServices
} from '../../bolt-cli/src/test/index.ts';
import { turn, until as untilTurned } from './support/turns.ts';
import { seed_accounts, type RuntimeAccount } from './support/accounts.ts';

const ACCOUNTS = [
	{ id: 'a', integration: 'whatsapp' },
	{ id: 'a1', integration: 'whatsapp' },
	{ id: 'b1', integration: 'whatsapp' },
	{ id: 'a2', integration: 'whatsapp' },
	{ id: 'a4', integration: 'whatsapp' },
	{ id: 'b4', integration: 'whatsapp' },
	{ id: 'a7', integration: 'whatsapp' },
	{ id: 'a8', integration: 'whatsapp' },
	{ id: 'a10', integration: 'whatsapp' },
	{ id: 'a24', integration: 'whatsapp' },
	{ id: 'r1', integration: 'whatsapp' },
	{ id: 'r2', integration: 'whatsapp' },
	{ id: 'r3', integration: 'whatsapp' },
	{ id: 's1', integration: 'whatsapp' },
	{ id: 's2', integration: 'whatsapp' },
	{ id: 's3', integration: 'whatsapp' },
	{ id: 'mail', integration: 'email' },
	{ id: 'tg', integration: 'telegram' },
	{ id: 'erp9', integration: 'erp' },
	{ id: 'cal2', integration: 'cal' },
] satisfies readonly RuntimeAccount[];

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
			credential: { api_key: { kind: 'text' } },
			http: {
				base_url: 'https://erp.example/api',
				auth: { header: { name: 'x-api-key', value: 'api_key' } }
			}
		},
		cal
	},

	policies: {
		self: {
			description: 'Manages their own accounts',
			grants: {
				sys_integration: { outputs: { default: true }, update: { verdict: true } }
			}
		}
	},
	teams: {},
	automations: {},
	mcp: {},
	apps: {},
	custom_fields: {},
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
	sent_at: '2026-10-14T10:00:00.000Z',
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
	over: { open?: Provider['open']; import_start?: NonNullable<Provider['import_start']>; idempotent_sends?: boolean } = {}
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
					provider_id: `${id}:${ctx.instance}:${String(Predicate.isObject(message) ? message['text'] : undefined)}`
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

/** `fake` with a history: its link answers `reconcile`. */
const withHistory = (id: string, reconcile: NonNullable<Link['reconcile']>): Provider => {
	const base = fake(id);
	return { ...base, open: async (ctx) => ({ ...(await base.open(ctx)), reconcile }) };
};

const key = randomBytes(32);
/** `self` changes only the accounts they own: one check over the batch, the stored owner against the actor. */
const OWNED = `function* own(changes, ctx) {
	const change = changes.find((c) => c.before.owner !== ctx.actor.id);
	return change === undefined ? ctx.allow() : yield* ctx.refuse('Only your own accounts change.', { at: change });
}
export default { policy: {
	self: { grants: { sys_integration: { update: { verdict: own } } } }
} };`;
const open = (m: EngineManifest = manifest, ports?: TestOptions<Drivers>['ports']) =>
	Effect.gen(function* () {
		const context = yield* Layer.build(
			TestWorkspace.layer({
				manifest: m,
				guest: yield* program(OWNED),
				host: { public_url: PUBLIC },
				secrets_key: Redacted.make(key),
				...(ports === undefined ? {} : { ports })
			})
		);
		const t = Context.get(context, TestWorkspace),
			store = yield* credentials(t.db, Context.get(context, Secrets)).pipe(
				Effect.provide(NodeCrypto.layer)
			),
			route = yield* route_fixture(context);
		const host = (providers: readonly Provider[], over: { enter?: LinksHost['enter']; credentials?: Credentials } = {}) =>
			integration_links({
				providers,
				enter: (effect) => effect.pipe(Effect.provide(context)),
				admit: (effect) => effect.pipe(Effect.provide(context)),
				credentials: store,
				public_url: PUBLIC,
				tcp: loopback_tcp_port,
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
		yield* seed_accounts(t.db, ACCOUNTS);
		const act = (authority: Authority, callable: string, input: Json) =>
			act_reply(route, authority, { acts: { [callable]: input }, issued_at: t.clock.now() }).pipe(
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
							about: { webhook_url: 'https://apex.example/acme/hooks/integration/a1' }
						});
						expect(present(present(yield* links.state('a1')).providers).map((p) => p.id)).toEqual([
							'twilio',
							'baileys'
						]);
						expect(yield* links.port.send('a1', { text: 'x' }, [])).toEqual({
							provider_id: 'twilio:a1:x'
						});
						expect(yield* links.port.send('b1', { text: 'y' }, [])).toEqual({
							provider_id: 'baileys:b1:y'
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

		it.effect("a new credential ends a resting sync's wait and keeps its health", () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, store } = yield* Fixture;
					yield* t.db.write({
						text: `INSERT INTO sys_sync (id, sync, instance, partition, health, digest, cycle, version)
						VALUES (gen_random_uuid(), 'resting', 'a4', '', $1::jsonb, 'd', 0, 0)`,
						params: [
							JSON.stringify({
								state: 'attention',
								failures: 3,
								retry_at: '2999-01-01T00:00:00.000Z'
							})
						]
					});
					const opened = yield* store.open('a4');
					yield* store.write(
						'a4',
						opened.epoch,
						new Map<string, Json>([['credential', { key: 'new' }]])
					);
					const [read] = yield* t.db.read([
						{ text: `SELECT health FROM sys_sync WHERE sync = 'resting'`, params: [] }
					]);
					expect(read?.rows).toEqual([{ health: { state: 'attention' } }]);
					yield* t.db.write({ text: `DELETE FROM sys_sync WHERE sync = 'resting'`, params: [] });
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
						expect(resumedWith.map((c) => [c.instance, c.personal, c.webhook_url])).toEqual([
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

	describe('reconcile', () => {
		const message = (id: string, thread: string, at: string) => ({
			id,
			thread,
			sent_at: at,
			from: { handle: thread, name: 'Ben' },
			text: 'missed',
			attachments: []
		});
		it.effect('reconciles recent threads one at a time when a link connects', () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, host } = yield* Fixture;
					const first = yield* host([fake('h1')]);
					yield* first.pair('r1', { key: 'k' });
					for (const [id, thread] of [
						['M1', 'one@s.whatsapp.net'],
						['M2', 'two@s.whatsapp.net']
					] as const)
						yield* t.receive('r1', message(id, thread, t.clock.now()));
					yield* first.close;
					let active = 0,
						most = 0;
					const asked: string[] = [];
					const links = yield* host([
						withHistory('h1', async (thread, since) => {
							most = Math.max(most, ++active);
							await new Promise((resolve) => setTimeout(resolve, 0));
							asked.push(thread);
							expect(since < t.clock.now()).toBe(true);
							active--;
							return {
								complete: false,
								messages: [message(`${thread}-missed`, thread, t.clock.now())]
							};
						})
					]);
					yield* links.resume;
					yield* until(() => asked.length === 2);
					expect(most).toBe(1);
					expect(asked.toSorted()).toEqual(['one@s.whatsapp.net', 'two@s.whatsapp.net']);
					yield* until(() => active === 0);
					yield* untilTurned(
						t.db
							.rows(Schema.Struct({ n: Schema.Number }), {
								text: `SELECT count(*)::int AS n FROM sys_message WHERE integration = 'r1' AND provider_id LIKE '%-missed'`,
								params: []
							})
							.pipe(Effect.map((rows) => rows[0]?.n === 2))
					);
					yield* links.close;
				})
			)
		);
		it.effect('stops when the link closes, and aborts the call in flight', () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { t, host } = yield* Fixture;
					const first = yield* host([fake('h2')]);
					yield* first.pair('r2', { key: 'k' });
					for (const n of [1, 2, 3])
						yield* t.receive('r2', message(`S${n}`, `t${n}@s.whatsapp.net`, t.clock.now()));
					yield* first.close;
					const asked: string[] = [];
					let aborted = false;
					const links = yield* host([
						withHistory('h2', (thread, _since, signal) => {
							asked.push(thread);
							return new Promise((_, reject) => {
								signal.addEventListener('abort', () => {
									aborted = true;
									reject(new Error('aborted'));
								});
							});
						})
					]);
					yield* links.resume;
					yield* until(() => asked.length === 1);
					yield* links.close;
					yield* until(() => aborted);
					expect(asked).toHaveLength(1);
				})
			)
		);
		it.effect(
			'one thread the platform refuses does not end the pass; a platform failure does',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, host } = yield* Fixture;
						const first = yield* host([fake('h3')]);
						yield* first.pair('r3', { key: 'k' });
						for (const n of [1, 2, 3])
							yield* t.receive('r3', message(`F${n}`, `f${n}@s.whatsapp.net`, t.clock.now()));
						yield* first.close;
						const run = (fail: () => unknown) =>
							Effect.gen(function* () {
								const asked: string[] = [];
								const links = yield* host([
									withHistory('h3', async (thread) => {
										asked.push(thread);
										throw fail();
									})
								]);
								yield* links.resume;
								yield* until(() => asked.length > 0);
								yield* Effect.sleep('30 millis');
								yield* links.close;
								return asked.length;
							});
						expect(
							yield* run(() => ({ kind: 'invalid', message: 'the bot left that channel' }))
						).toBe(3);
						expect(yield* run(() => ({ kind: 'rate_limited', message: 'slow down' }))).toBe(1);
					})
				)
		);
		/** The case's workspace, with the manager on its clock: `t.clock` is the day that passes. */
		const onItsClock = <A, E>(
			body: (workspace: Effect.Success<ReturnType<typeof open>>) => Effect.Effect<A, E, Scope.Scope>
		) =>
			Effect.scoped(
				Effect.gen(function* () {
					const workspace = yield* open();
					return yield* body(workspace).pipe(
						Effect.provideService(Clock.Clock, Context.get(workspace.context, Clock.Clock))
					);
				})
			);
		/** `t.settled` waits for a woken fiber to sleep again, and the reconcile fiber waits on a connect instead. */
		const settle = (t: Kit, by: string) =>
			Effect.gen(function* () {
				t.clock.advance(by);
				for (let n = 0; n < 20; n++) yield* turn;
			});
		it.effect('reconnects are floored, and a link stays reconciled once a day', () =>
			onItsClock(({ t, host }) =>
				Effect.gen(function* () {
					let ctx: DriverOpen | undefined;
					const asked: string[] = [];
					const base = withHistory('h4', async (thread) => {
						asked.push(thread);
						return { complete: false, messages: [] };
					});
					const links = yield* host([
						{
							...base,
							open: async (c) => {
								ctx = c;
								return base.open(c);
							}
						}
					]);
					yield* t.receive('a1', message('D1', 'day@s.whatsapp.net', t.clock.now()));
					yield* links.pair('a1', { key: 'k' });
					yield* until(() => asked.length === 1);
					const provider = present(ctx);
					yield* driverCall(() => provider.status({ state: 'reconnecting' }));
					yield* driverCall(() => provider.status({ state: 'connected', account: 'k' }));
					yield* settle(t, '1min');
					expect(asked).toHaveLength(1);
					yield* settle(t, '61min');
					yield* until(() => asked.length === 2);
					yield* settle(t, '2h');
					yield* settle(t, '1d');
					yield* until(() => asked.length === 3);
					yield* links.close;
				})
			)
		);
		it.effect('an idle channel asks the database nothing once it found nothing recent', () =>
			onItsClock(({ t, context, host }) =>
				Effect.gen(function* () {
					const asked: string[] = [];
					let recents = 0;
					const conversations = Context.get(context, Conversations);
					const links = yield* host(
						[
							withHistory('h5', async (thread) => {
								asked.push(thread);
								return { complete: false, messages: [] };
							})
						],
						{
							enter: (effect) =>
								effect.pipe(
									Effect.provideService(Conversations, {
										...conversations,
										recent: (instance) =>
											conversations.recent(instance).pipe(
												Effect.ensuring(
													Effect.sync(() => {
														recents++;
													})
												)
											)
									}),
									Effect.provide(context)
								)
						}
					);
					yield* links.pair('a1', { key: 'k' });
					yield* until(() => recents === 1);
					yield* settle(t, '2h');
					yield* settle(t, '1d');
					yield* settle(t, '2h');
					yield* settle(t, '1d');
					expect(recents).toBe(1);
					expect(asked).toEqual([]);
					yield* links.close;
				})
			)
		);
	});

	describe('a send and the link it goes through', () => {
		it.effect('first pairing and a restored host wake due and future messages in account FIFO order', () =>
			Effect.scoped(Effect.gen(function* () {
				const fixture = yield* open(manifest, calDrivers), { t, context, host } = fixture;
				yield* Effect.gen(function* () {
					const conversations = Context.get(context, Conversations), outbound = Context.get(context, Outbound);
					const resumes: { instance: string; state: string | null }[] = [];
					const resume = outbound.resume;
					const observe = vi.spyOn(outbound, 'resume').mockImplementation((instance) => Effect.gen(function* () {
						resumes.push({ instance, state: yield* t.db.value(Schema.NullOr(Schema.String), {
							text: "SELECT status->>'state' FROM sys_integration WHERE id=$1", params: [instance]
						}) });
						return yield* resume(instance);
					}));
					yield* Effect.addFinalizer(() => Effect.sync(() => observe.mockRestore()));
					const sent: { instance: string; id: string; to: string; text: string }[] = [];
					const opened: DriverOpen[] = [], before_live: boolean[] = [];
					const run = yield* FiberSet.makeRuntimePromise();
					const base = fake('queued', opened);
					const provider: Provider = { ...base, open: async (ctx) => {
						const link = await base.open(ctx);
						if ((await ctx.credentials.load()).has('credential')) {
							const waiting = await run(current().port.send(ctx.instance, {
								id: 'readiness-probe', to: 'queue@s.whatsapp.net', text: 'not published yet'
							}, []).pipe(Effect.result));
							before_live.push(Result.isFailure(waiting) && waiting.failure instanceof Unavailable && waiting.failure.facility === LINK_DOWN);
						}
						return { ...link, send: async (message) => {
							const value = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String, to: Schema.String, text: Schema.String }))(message);
							sent.push({ instance: ctx.instance, ...value });
							return { provider_id: `accepted:${value.id}` };
						} };
					} };
					const first = yield* host([provider]);
					calLinks = first;
					const queue = (instance: string, text: string) => conversations.send(instance, { to: 'queue@s.whatsapp.net', text }, {});
					const first_id = yield* queue('a', 'First'), future_id = yield* queue('a', 'Second');
					const other_id = yield* queue('b1', 'Other account');
					yield* t.db.write({ text: "UPDATE sys_integration SET active=false WHERE id='a2'", params: [] });
					const paused_id = yield* queue('a2', 'Paused account');
					const future = new Date(Date.parse(t.clock.now()) + 10 * 86_400_000).toISOString();
					yield* t.db.write({ text: 'UPDATE sys_message SET next_attempt_at=$2::timestamptz WHERE id=$1', params: [future_id, future] });
					const rows = () => t.db.rows(Schema.Struct({
						id: Schema.String, integration: Schema.String, status: Schema.String, attempts: Schema.Int,
						sent_at: Schema.NullOr(Schema.String), claimed_at: Schema.NullOr(Schema.String)
					}), { text: "SELECT id,integration,status,attempts,sent_at::text,claimed_at::text FROM sys_message WHERE direction='outbound' ORDER BY seq", params: [] });
					expect(yield* rows()).toEqual([
						{ id: first_id, integration: 'a', status: 'queued', attempts: 0, sent_at: null, claimed_at: null },
						{ id: future_id, integration: 'a', status: 'queued', attempts: 0, sent_at: null, claimed_at: null },
						{ id: other_id, integration: 'b1', status: 'queued', attempts: 0, sent_at: null, claimed_at: null },
						{ id: paused_id, integration: 'a2', status: 'queued', attempts: 0, sent_at: null, claimed_at: null }
					]);
					expect(sent).toEqual([]);
					expect(opened).toEqual([]);
					yield* first.pair('a', { key: 'paired' });
					expect(resumes).toEqual([{ instance: 'a', state: 'connected' }]);
					expect((yield* t.run_due()).failed).toEqual([]);
					expect(sent.map(({ instance, id, text }) => ({ instance, id, text }))).toEqual([
						{ instance: 'a', id: first_id, text: 'First' }, { instance: 'a', id: future_id, text: 'Second' }
					]);
					const first_rows = yield* rows();
					expect(first_rows.slice(0, 2)).toMatchObject([{ status: 'sent', attempts: 1, sent_at: expect.any(String) }, { status: 'sent', attempts: 1, sent_at: expect.any(String) }]);
					expect(first_rows.slice(2)).toMatchObject([{ id: other_id, status: 'queued', attempts: 0, sent_at: null }, { id: paused_id, status: 'queued', attempts: 0, sent_at: null }]);
					yield* driverCall(() => present(opened[0]).status({ state: 'reconnecting' }));
					const restored_id = yield* queue('a', 'After restart');
					expect((yield* rows()).find(({ id }) => id === restored_id)).toMatchObject({ status: 'queued', attempts: 0, sent_at: null, claimed_at: null });
					yield* first.close;
					const restored = yield* host([provider]);
					calLinks = restored;
					yield* restored.resume;
					expect(before_live).toEqual([true]);
					expect(resumes).toEqual([{ instance: 'a', state: 'connected' }, { instance: 'a', state: 'connected' }]);
					expect((yield* t.run_due()).failed).toEqual([]);
					expect(sent.map(({ id }) => id)).toEqual([first_id, future_id, restored_id]);
					expect((yield* rows()).find(({ id }) => id === restored_id)).toMatchObject({ status: 'sent', attempts: 1, sent_at: expect.any(String) });
					yield* restored.pair('b1', { key: 'other' });
					expect((yield* t.run_due()).failed).toEqual([]);
					expect(sent.map(({ id }) => id)).toEqual([first_id, future_id, restored_id, other_id]);
					expect((yield* rows()).find(({ id }) => id === paused_id)).toMatchObject({ status: 'queued', attempts: 0, sent_at: null });
					yield* restored.close;
				}).pipe(Effect.provide(context));
			})).pipe(Effect.ensuring(Effect.sync(() => { calLinks = undefined; })))
		);
		it.effect(
			'a paired link that is not connected is down: it calls no provider, and its connect delivers what waited',
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, context, host } = yield* Fixture;
						let ctx: DriverOpen | undefined,
							sends = 0;
						const base = fake('s1');
						const links = yield* host([
							{
								...base,
								open: async (c) => {
									ctx = c;
									const link = await base.open(c);
									return {
										...link,
										send: async () => {
											sends++;
											return { provider_id: `sent:${sends}` };
										}
									};
								}
							}
						]);
						calLinks = links;
						yield* links.pair('s1', { key: 'k' });
						const provider = present(ctx);
						yield* driverCall(() => provider.status({ state: 'reconnecting' }));
						expect(yield* links.port.send('s1', { text: 'x' }, []).pipe(Effect.flip)).toMatchObject(
							{ _tag: 'Unavailable', facility: LINK_DOWN }
						);
						expect(sends).toBe(0);
						yield* Context.get(context, Conversations)
							.send('s1', { to: 'down@s.whatsapp.net', text: 'wait' }, {})
							.pipe(Effect.provide(context));
						expect(sends).toBe(0);
						yield* driverCall(() => provider.status({ state: 'connected', account: 'k' }));
						yield* t.run_due();
						yield* until(() => sends === 1);
						yield* links.close;
					})
				).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							calLinks = undefined;
						})
					)
				)
		);
		it.effect('a valid account with no credentials waits for initial pairing without calling a provider', () =>
			Effect.scoped(
				Effect.gen(function* () {
					const { host } = yield* Fixture;
					const links = yield* host([fake('s2')]);
					const failure = yield* links.port.send('s2', { text: 'x' }, []).pipe(Effect.flip);
					expect(failure).toMatchObject({ _tag: 'Unavailable', facility: LINK_DOWN });
					yield* links.close;
				})
			)
		);
		it.effect(
			"a reconnect checks durable queued work once; a provider's idempotence lands on the row",
			() =>
				Effect.scoped(
					Effect.gen(function* () {
						const { t, host, row } = yield* Fixture;
						let ctx: DriverOpen | undefined;
						const base = fake('s3', [], 'whatsapp', { idempotent_sends: true });
						const links = yield* host([
							{
								...base,
								open: async (c) => {
									ctx = c;
									return base.open(c);
								}
							}
						]);
						yield* links.pair('s3', { key: 'k' });
						expect((yield* row('s3'))['status']).toMatchObject({ idempotent_sends: true });
						const provider = present(ctx);
						t.count.reset();
						yield* driverCall(() => provider.status({ state: 'reconnecting' }));
						yield* driverCall(() => provider.status({ state: 'connected', account: 'k' }));
						provider.pairing(null);
						expect(t.count).toMatchObject({ reads: 0, writes: 1 });
						// a watcher hears it from what the link holds, too
						const heard = yield* Queue.unbounded<InstanceStatus>();
						yield* links.watch('s3').pipe(
							Stream.runForEach((status) => Queue.offer(heard, status)),
							Effect.forkScoped
						);
						expect((yield* Queue.take(heard)).state).toBe('connected');
						t.count.reset();
						yield* driverCall(() => provider.status({ state: 'reconnecting' }));
						expect((yield* Queue.take(heard)).state).toBe('reconnecting');
						expect(t.count.reads).toBe(0);
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
							provider_id: 'p8:a8:y'
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
						yield* links.pair('erp9', { api_key: 'k' });
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
							credential: { api_key: 'k' },
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
			t.as(t.member(policies, over)).pipe(Effect.map((member) => member.authority));
		/** The verb routes over one manager; `as` names the session's authority for the next request. */
		const verbs = (
			workspace: Context.Context<TestWorkspace | WorkspaceServices>,
			links: LinkManager
		) => {
			let who: Authority | null = null;
			const handle = (request: Request) =>
				integration_routes(HttpServerRequest.fromWeb(request)).pipe(
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
								yield* act((yield* t.as(t.admin)).authority, 'sys_integration.create', [
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
							present(yield* call(as(yield* member(t, ['self'])), phone, 'pair', { key: 'x' })).status
						).toBe(403);
						expect(
							present(yield* call(as(yield* member(t, ['self'], { external: true })), phone)).status
						).toBe(403);
						expect(present(yield* call(as((yield* t.as(alice)).authority), 'a')).status).toBe(403); // a workspace instance is not hers
						expect(yield* sealed(phone)).toEqual({});
						expect(
							present(
								yield* call(as((yield* t.as(alice)).authority), phone, 'pair', {
									key: 'mine'
								})
							).status
						).toBe(200);
						expect(present(yield* call(as((yield* t.as(t.admin)).authority), phone)).status).toBe(200);
						// a personal account sends no test message
						expect(
							yield* json(present(yield* call(as((yield* t.as(alice)).authority), phone, 'test', {})))
						).toEqual({
							error: { code: 'invalid_input', message: 'A personal account sends no test message.' }
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
								steps: [{ text: 'Register this redirect URI', copy: 'redirect_url' }],
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
										return { provider_id: '<x@acme.example>' };
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
						expect(present(yield* links.state('mail')).about).toEqual({ redirect_url: REDIRECT });
						// before any sign-in started, a callback reaches no link
						expect(
							(yield* links.callback(new Request(`${REDIRECT}?code=c&state=x.mail`))).status
						).toBe(400);
						yield* links.pair('mail', {});
						expect(state).toMatch(/^[\w-]{36}\.mail$/);
						const wire = present(
							decode_status(
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
							'redirect_url'
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
								import_start: { kind: 'timestamp', precision: 'second' }
							})
						]);
						const admin = (yield* t.as(t.admin)).authority;
						yield* links.pair(
							'a24',
							{ key: 'k', import_start: { kind: 'since', date: '2026-10-21', zone: 'Asia/Seoul' } },
							admin
						);
						const first = present(opened[0]);
						expect(first.import_start).toEqual({
							kind: 'since',
							at: '2026-10-20T15:00:00.000Z',
							zone: 'Asia/Seoul',
							origin: 'date'
						});
						yield* driverCall(() => first.credentials.write(new Map([['state', { uid: 42 }]])));
						const stored = yield* sealed('a24');
						const before = Date.now();
						yield* links.import_start('a24', { kind: 'now', zone: 'Asia/Seoul' }, admin);
						const after = Date.now();
						expect(opened).toHaveLength(2);
						const applied = present(opened[1]).import_start;
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
						).toMatchObject({ code: 'source_changed' });
						expect(yield* links.state('a24')).toMatchObject({
							state: 'connected',
							account: 'k',
							import_start: applied
						});
						yield* links.close;
						const resumed: DriverOpen[] = [];
						const next = yield* host([
							fake('pi', resumed, 'whatsapp', {
								import_start: { kind: 'timestamp', precision: 'second' }
							})
						]);
						yield* next.resume;
						expect(present(resumed[0]).import_start).toEqual(applied);
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
							yield* act((yield* t.as(t.admin)).authority, 'sys_integration.update', [
								{
									target: { id: 'cal2' },
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
							yield* act((yield* t.as(t.admin)).authority, 'sys_integration.update', [
								{
									target: { id: 'cal2' },
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
								yield* act((yield* t.as(t.admin)).authority, 'sys_integration.create', [
									{
										integration: 'cal',
										name: 'Other calendar'
									}
								])
							).records[0]
						).id;
						yield* links.pair(other, {});
						ok(yield* act((yield* t.as(t.admin)).authority, 'sys_integration.delete', [{ target: { id: other } }]));
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
	expect(oauth_client_of({}, {}, host, 'google')).toEqual(host.google);
	expect(oauth_client_of(declared, { ID: 'own', SECRET: 'shh' }, host, 'google')).toEqual({
		id: 'own',
		secret: 'shh'
	});
	expect(oauth_client_of(declared, { ID: 'own' }, host, 'google')).toEqual(host.google);
	expect(oauth_client_of(declared, { ID: 'own', SECRET: '' }, undefined, 'google')).toBeUndefined();
});
