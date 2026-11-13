import { uuid } from '../port.ts';
import {
	Clock,
	Crypto,
	Effect,
	Exit,
	FiberSet,
	Latch,
	Layer,
	Option,
	Predicate,
	PubSub,
	RcMap,
	Result,
	Schedule,
	Schema,
	Scope,
	Semaphore,
	Stream
} from 'effect';
import { bindingsAt } from '../query/reader.ts';
import { DRIVERS, type DriverName, type IntegrationSpec } from '../../decl/runtime/integration.ts';
import type { Json } from '../../decl/values.ts';
import { under } from '../../protocol/wire.ts';
import {
	ImportStart,
	ImportStartInput,
	LinkStatus as LinkStatusSchema
} from '../../protocol/schema.ts';
import { resolveImportStart } from './import-start.ts';
import type {
	InstanceStatus,
	IntegrationOffer,
	LinkStatus,
	Pairing,
	ProviderChoice
} from '../../protocol/instance-status.ts';
import { LIMITS, type Authority, type TcpPort } from '../contracts.ts';
import { TenantDb } from '../db/tenant-db.ts';
import { SendRefused } from '../conversations/status.ts';
import { Fenced, is_transient, type EngineError } from '../errors.ts';
import { BoltError } from '../../protocol/errors.ts';
import { FacilityFailure, Unavailable } from '../../decl/errors.ts';
import { Drivers } from '../ports.ts';
import { Port, type PortFailure } from '../port.ts';
import {
	Conversations,
	Guest,
	Links,
	Live,
	Manifest,
	Outbound,
	Reads,
	Wake,
	Writes
} from '../services.ts';
import { mayUpdate } from '../write/act.ts';
import { canonical } from '@norbital-ai/store';
import type { Credentials, InstanceRow } from './credentials.ts';
import { oauth_client_of, type OAuthClient, type OAuthVendor, type Provider } from './driver.ts';
import { LINK_DOWN, linkCalls, linkFailure, type LinkCalls } from './abi.ts';
import { conversational, definitionOf, writeStatus } from './instances.ts';
import { SYSTEM } from '../../system/index.ts';
import { Syncs, syncs_of } from '../sync/index.ts';
import { verifiedWebhook } from './webhook.ts';

export const HOOKS = '/hooks/integration/';
export const OAUTH_CALLBACK = '/hooks/oauth/callback';
export const webhook_url = (public_url: string, instance: string): string =>
	under(public_url, `${HOOKS}${encodeURIComponent(instance)}`);
export type LinkAdmission =
	TenantDb | Manifest | Conversations | Outbound | Syncs | Live | Wake | Reads | Writes | Guest;
export type LinksHost = {
	readonly providers: readonly Provider[];
	/** A link's own work on the workspace (an ingest, a status), outside the compute envelope. */
	readonly enter: <A, E>(
		work: Effect.Effect<A, E, LinkAdmission>
	) => Effect.Effect<A, E | EngineError>;
	/** A guest body (a custom conversation's webhook, a test send), admitted under the compute envelope. */
	readonly admit: <A, E>(
		work: Effect.Effect<A, E, LinkAdmission>
	) => Effect.Effect<A, E | EngineError>;
	readonly credentials: Credentials;
	readonly public_url: string;
	readonly secrets?: Readonly<Record<string, string>> | undefined;
	/** The host's own OAuth clients, used where a definition sets none of its own (a tenant need not register an app). */
	readonly oauth?: Partial<Record<OAuthVendor, OAuthClient>> | undefined;
	readonly fetch?: typeof fetch | undefined;
	readonly tcp: TcpPort;
	readonly log?: ((line: string) => void) | undefined;
};
type LinkError = EngineError | PortFailure | SendRefused;
export type LinkManager = {
	readonly port: Drivers['Service'];
	readonly resume: Effect.Effect<void, LinkError>;
	readonly state: (instance: string) => Effect.Effect<InstanceStatus | undefined, LinkError>;
	/** Every definition with the providers this host offers for it, personal and workspace. */
	readonly offers: Effect.Effect<readonly IntegrationOffer[], LinkError>;
	/** All instances when omitted; the HTTP batch route applies the viewer's authority to every status. */
	readonly watch: (instance?: string) => Stream.Stream<InstanceStatus, LinkError>;
	readonly pair: (
		instance: string,
		input: Json,
		authority?: Authority
	) => Effect.Effect<void, LinkError>;
	readonly import_start: (
		instance: string,
		input: ImportStartInput,
		authority: Authority
	) => Effect.Effect<void, LinkError>;
	readonly unpair: (instance: string) => Effect.Effect<void, LinkError>;
	readonly test: (instance: string, input: Json) => Effect.Effect<void, LinkError>;
	readonly discover: (
		instance: string
	) => Effect.Effect<readonly { readonly id: string; readonly label: string }[], LinkError>;
	readonly may: (
		authority: Authority,
		instance: string
	) => Effect.Effect<boolean | null, LinkError>;
	readonly webhook: (instance: string, request: Request) => Effect.Effect<Response, LinkError>;
	readonly callback: (request: Request) => Effect.Effect<Response, LinkError>;
	readonly close: Effect.Effect<void>;
};
const PROVIDER = 'provider';
const DURABLE = new Set<LinkStatus['state']>(['connected', 'unpaired', 'error']);
const REPLACED =
	'Another host opened this account, so this link stopped. Pair it again here to take it back.';
const fenced = (instance: string) => new Fenced({ instance, message: REPLACED });
const EXPIRED = 'This sign-in is unknown or has expired; start it again.';
const TEST_TEXT = 'Norbital test message: this integration is connected.';
const DAY = 86_400_000;
/** The least time between two reconciles of a link, however often it reconnects. */
const RECONCILE_GAP_MS = 3_600_000;
const isRequest = (driver: DriverName) => 'request' in DRIVERS[driver];
const unavailable = (reason: string) => BoltError.make('unavailable', 'facility', reason);
const gone = (instance: string) =>
	BoltError.make('not_found', 'facility', `no integration instance '${instance}'`);
const RowSchema = Schema.Struct({
	integration: Schema.String,
	owner: Schema.NullOr(Schema.String),
	active: Schema.Boolean,
	status: Schema.Json,
	stored: Schema.Boolean,
	import_start: Schema.NullOr(ImportStart)
});
type Row = {
	integration: string;
	definition: IntegrationSpec;
	personal: boolean;
	active: boolean;
	status: Json;
	stored: boolean;
	import_start: ImportStart | null;
};
type Held = {
	instance: string;
	integration: string;
	definition: IntegrationSpec;
	personal: boolean;
	import_start: ImportStart | null;
	provider: Provider;
	request: boolean;
	epoch: string | null;
	values: Map<string, Json>;
	calls: LinkCalls;
	status: LinkStatus;
	since: string;
	pairing: Pairing | null;
	written: string | null;
	replaced: boolean;
	/** Shared with the opened copy: set when a new import start retires this link, so its late imports are refused. */
	boundary: { changed: boolean };
	/** Shared with the opened copy so a quiet reconcile has nothing to ask until another message moves. */
	flow: {
		/** Open from each connect until a reconcile takes it. */
		readonly connects: Latch.Latch;
		/** The last reconcile found no recent thread and no message moved since: the next has nothing to ask. */
		idle: boolean;
	};
	stop?: Effect.Effect<void, PortFailure> | undefined;
};
type HeldState = Omit<Held, 'calls'>;
type Opened = {
	epoch: string | null;
	row: InstanceRow;
	values: ReadonlyMap<string, Json>;
	definition: IntegrationSpec;
};
const wipe = (names: Iterable<string>) =>
	new Map([...names].map((name): [string, null] => [name, null]));

export const integration_links = (
	h: LinksHost
): Effect.Effect<LinkManager, never, Scope.Scope | Crypto.Crypto> =>
	Effect.gen(function* () {
		const crypto = yield* Crypto.Crypto;
		const newId = uuid(crypto);
		const f = h.fetch ?? fetch;
		const callbacks = yield* FiberSet.make<unknown, LinkError>();
		// one instant of the day per manager: a workspace's links reconcile in one wake, and workspaces spread out
		const reconcileAt = Math.floor(Math.random() * DAY);
		const events = yield* Effect.acquireRelease(
			PubSub.unbounded<InstanceStatus>(),
			PubSub.shutdown
		);
		const live = new Map<string, Held>();
		const leases = new Map<string, Scope.Closeable>();
		const locks = yield* RcMap.make({ lookup: (_instance: string) => Semaphore.make(1) });
		const selected = new Map<string, { provider: Provider; opened: Opened }>();
		let stopped = false,
			watchers = 0;
		const logged = <A, E>(effect: Effect.Effect<A, E>) =>
			effect.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
		const serial = <A, E>(
			instance: string,
			work: Effect.Effect<A, E>
		): Effect.Effect<A, E | BoltError> =>
			Effect.scoped(
				RcMap.get(locks, instance).pipe(
					Effect.flatMap((lock) =>
						lock.withPermit(
							Effect.suspend((): Effect.Effect<A, E | BoltError> =>
								stopped ? Effect.fail(unavailable('the integration links are closed')) : work
							)
						)
					)
				)
			);
		const choices = (driver: DriverName, personal: boolean) =>
			h.providers.filter(
				(provider) => provider.driver === driver && (!personal || provider.personal === true)
			);
		const pick = (driver: DriverName, stored: Json | undefined, personal: boolean) => {
			const providers = choices(driver, personal);
			return stored === undefined
				? providers.length === 1
					? providers[0]
					: undefined
				: providers.find((provider) => provider.id === stored);
		};
		/** The providers an instance of `definition` is offered, each saying whether this host can sign it in. */
		const offered = (definition: IntegrationSpec, personal: boolean) =>
			choices(definition.driver, personal).map((provider): ProviderChoice => ({
				id: provider.id,
				...(provider.name === undefined ? {} : { name: provider.name }),
				...(provider.description === undefined ? {} : { description: provider.description }),
				...(provider.icon === undefined ? {} : { icon: provider.icon }),
				...(provider.import_start === undefined ? {} : { import_start: provider.import_start }),
				...(provider.describe?.({ personal, definition }) ?? {
					label: provider.label,
					setup: provider.setup
				}),
				...(provider.oauth === undefined ||
				oauth_client_of(definition, h.secrets, h.oauth, provider.oauth) !== undefined
					? {}
					: { available: false })
			}));
		const row = (instance: string) =>
			h.enter(
				Effect.gen(function* () {
					const db = yield* TenantDb;
					const manifest = yield* Manifest;
					const found = yield* db.one(RowSchema, {
						text: `SELECT integration, owner, active, status, import_start, EXISTS (SELECT 1 FROM bolt_credential c WHERE c.instance = i.id) AS stored FROM sys_integration i WHERE i.id = $1`,
						params: [instance]
					});
					if (Option.isNone(found)) return undefined;
					const x = found.value,
						definition = definitionOf(manifest, x.integration);
					return definition === undefined
						? undefined
						: {
								integration: x.integration,
								definition,
								personal: x.owner !== null,
								active: x.active,
								status: x.status,
								stored: x.stored,
								import_start: x.import_start
							};
				})
			);
		const definition = (instance: InstanceRow) =>
			h.enter(
				Effect.gen(function* () {
					const manifest = yield* Manifest;
					const value = definitionOf(manifest, instance.integration);
					return value === undefined ? yield* Effect.fail(gone(instance.integration)) : value;
				})
			);
		const view = (
			instance: string,
			x: Row,
			held: HeldState | undefined = live.get(instance)
		): InstanceStatus => {
			const providers = offered(x.definition, x.personal);
			const stored = Schema.decodeUnknownOption(LinkStatusSchema)(x.status);
			const verified =
				x.definition.driver !== 'sqlserver' ||
				(Predicate.isObject(x.status) && x.status['databaseVerified'] === true);
			const base: LinkStatus & { since?: string; pairing?: Pairing | null } =
				held !== undefined
					? { ...held.status, since: held.since, pairing: held.pairing }
					: Option.isSome(stored) &&
						  DURABLE.has(stored.value.state) &&
						  (stored.value.state !== 'connected' || verified)
						? stored.value
						: { state: 'unpaired' };
			const about = base.about;
			return {
				...base,
				instance,
				integration: x.integration,
				driver: x.definition.driver,
				stored: held === undefined ? x.stored : held.values.size > 0,
				...(held === undefined ? {} : { provider: held.provider.id }),
				...(!x.personal && held?.provider.test !== undefined && base.state === 'connected'
					? { test: held.provider.test }
					: {}),
				providers,
				import_start: x.import_start,
				about: {
					...(Schema.is(Schema.Record(Schema.String, Schema.Json))(about) ? about : {}),
					...(providers.some((provider) => provider.setup.webhook === true)
						? { webhook_url: webhook_url(h.public_url, instance) }
						: {}),
					...(providers.some((provider) =>
						provider.setup.steps.some((step) => step.copy === 'redirect_url')
					)
						? { redirect_url: under(h.public_url, OAUTH_CALLBACK) }
						: {})
				}
			};
		};
		const state = (instance: string) =>
			row(instance).pipe(Effect.map((x) => (x === undefined ? undefined : view(instance, x))));
		const publish = (instance: string) =>
			Effect.suspend(() =>
				watchers === 0
					? Effect.void
					: state(instance).pipe(
							Effect.flatMap((value) =>
								value === undefined
									? Effect.void
									: PubSub.publish(events, value).pipe(Effect.asVoid)
							)
						)
			);
		/** A link's own movement, for whoever watches: all of it is what the link holds, so a reconnect reads no database. */
		const moved = (held: HeldState) =>
			Effect.suspend(() =>
				watchers === 0
					? Effect.void
					: PubSub.publish(
							events,
							view(held.instance, { ...held, active: true, status: null, stored: false }, held)
						).pipe(Effect.asVoid)
			);
		const status = (instance: string, patch: { readonly [key: string]: Json }) =>
			h.enter(writeStatus(instance, patch));
		const testSync = (instance: string) =>
			h.admit(Effect.flatMap(Syncs, (syncs) => syncs.test(instance)));
		const databaseTestMessage =
			'The SQL Server connection test failed. Check the endpoint, credentials and schema, then try again.';
		const verifyDatabase = (instance: string, check: Effect.Effect<void, LinkError>) =>
			check.pipe(
				Effect.andThen(testSync(instance)),
				Effect.tap(() =>
					status(instance, { state: 'connected', databaseVerified: true, error: null, code: null })
				),
				Effect.catch((cause) =>
					status(instance, {
						state: 'error',
						databaseVerified: false,
						code: 'databaseTestFailed',
						error: databaseTestMessage
					}).pipe(
						Effect.andThen(
							Effect.fail(BoltError.make('invalid_input', 'facility', databaseTestMessage, cause))
						)
					)
				)
			);
		const replace = (held: HeldState) =>
			Effect.gen(function* () {
				if (held.replaced) return;
				held.replaced = true;
				held.status = { state: 'error', code: 'replaced', error: REPLACED };
				held.pairing = null;
				held.since = new Date(yield* Clock.currentTimeMillis).toISOString();
				yield* held.stop ?? Effect.void;
				yield* moved(held);
			});
		const persist = (held: HeldState, changes: ReadonlyMap<string, Json | null>) =>
			Effect.gen(function* () {
				if (held.replaced)
					return yield* Effect.fail(fenced(held.instance));
				const epoch = yield* h.credentials
					.write(held.instance, held.epoch, changes, held.request)
					.pipe(
						Effect.tapError((error) =>
							error._tag === 'Fenced' || (error._tag === 'BoltError' && error.code === 'fenced')
								? replace(held)
								: Effect.logWarning(error)
						),
						Effect.retry({
							times: 4,
							schedule: Schedule.min([
								Schedule.exponential('100 millis'),
								Schedule.spaced('5 seconds')
							]),
							while: (error) =>
								error._tag !== 'Fenced' &&
								!(
									error._tag === 'BoltError' &&
									(error.code === 'fenced' || error.code === 'not_found')
								)
						})
					);
				held.epoch = epoch;
				for (const [key, value] of changes)
					if (value === null) held.values.delete(key);
					else held.values.set(key, value);
			}).pipe(Effect.uninterruptible);
		/** Durable queued rows become due on each connection, including the first pairing and a restored host. */
		const resumeSends = (held: HeldState) =>
			Effect.suspend(() =>
				held.status.state === 'connected' && live.get(held.instance) === held
					? h.enter(Effect.flatMap(Outbound, (outbound) => outbound.resume(held.instance))).pipe(logged)
					: Effect.void
			);
		const report = (held: HeldState, patch: LinkStatus) =>
			Effect.gen(function* () {
				if (held.replaced) return;
				const decoded = yield* Schema.decodeUnknownEffect(LinkStatusSchema)(patch).pipe(
					Effect.mapError(() =>
						BoltError.make('bad_answer', 'facility', 'the link reported an invalid status')
					)
				);
				const connected = decoded.state === 'connected' && held.status.state !== 'connected';
				if (decoded.state !== held.status.state)
					held.since = new Date(yield* Clock.currentTimeMillis).toISOString();
				held.status = decoded;
				if (decoded.state !== 'pairing') held.pairing = null;
				yield* moved(held);
				if (!DURABLE.has(decoded.state)) return;
				const durable = {
					state: decoded.state,
					account: decoded.account ?? null,
					error: decoded.error ?? null,
					code: decoded.code ?? null,
					last_disconnect: decoded.last_disconnect ?? null,
					// on the row, because delivery runs in the workspace and the provider is known only here
					idempotent_sends: held.provider.idempotent_sends ?? null
				};
				const key = canonical(durable);
				if (key !== held.written) {
					yield* status(held.instance, durable);
					held.written = key;
				}
				if (connected) {
					yield* held.flow.connects.open;
					yield* resumeSends(held);
				}
			});
		/**
		 * One pass over `held`'s recent threads, one at a time: the fiber ends with the link's scope, and a link that left
		 * `connected` ends the pass. A thread the platform refuses is that thread's trouble; any other failure is the
		 * platform's, so the pass stops and the next one tries again.
		 */
		const reconcilePass = (held: Held) =>
			Effect.gen(function* () {
				const up = () =>
					!held.replaced && !held.boundary.changed && held.status.state === 'connected';
				if (held.flow.idle || !up()) return;
				// before the read: a message that lands during it clears this
				held.flow.idle = true;
				const { since, threads } = yield* h.enter(
					Effect.flatMap(Conversations, (conversations) => conversations.recent(held.instance))
				);
				if (threads.length > 0) held.flow.idle = false;
				for (const thread of threads) {
					if (!up()) return;
					yield* held.calls.reconcile(thread, since).pipe(
						Port.call('link.reconcile', LIMITS.callMs.http),
						Effect.flatMap((page) =>
							h.enter(
								Effect.flatMap(Conversations, (conversations) =>
									conversations.repair(held.instance, thread, since, page, held.import_start)
								)
							)
						),
						Effect.catchTag('FacilityFailure', (failure) =>
							failure.kind === 'invalid' || failure.kind === 'unsupported'
								? Effect.logWarning(failure)
								: Effect.fail(failure)
						)
					);
				}
			});
		/** On each connect, and once a day while connected: a webhook is a hint, and a link repairs what it missed. */
		const reconciling = (held: Held) =>
			Effect.gen(function* () {
				yield* held.flow.connects.await;
				for (;;) {
					yield* held.flow.connects.close;
					yield* logged(reconcilePass(held));
					yield* Effect.sleep(RECONCILE_GAP_MS);
					const now = yield* Clock.currentTimeMillis;
					yield* Effect.raceFirst(
						held.flow.connects.await,
						Effect.sleep((((reconcileAt - now) % DAY) + DAY) % DAY)
					);
				}
			});
		const checkedStart = (provider: Provider, value: Json | null) =>
			Effect.gen(function* () {
				const start = yield* Schema.decodeUnknownEffect(Schema.NullOr(ImportStart))(value).pipe(
					Effect.mapError(() =>
						BoltError.make('invalid_input', 'admission', 'Choose a valid import start.')
					)
				);
				if (start === null || start.kind === 'all') return start;
				if (start.kind === 'since') {
					if (provider.import_start?.kind !== 'timestamp')
						return yield* Effect.fail(
							unavailable('This provider does not support a time-based import start.')
						);
					return start;
				}
				const capability = provider.import_start,
					validate = provider.validate_import_start?.bind(provider);
				if (
					start.provider !== provider.id ||
					capability?.kind !== 'native' ||
					validate === undefined ||
					capability.fields.some((field) => field.secret === true)
				)
					return yield* Effect.fail(
						unavailable('This provider does not support that import position.')
					);
				if (
					Object.keys(start.values).some(
						(key) => !capability.fields.some((field) => field.name === key)
					)
				)
					return yield* Effect.fail(
						BoltError.make(
							'invalid_input',
							'admission',
							'The import position contains an unknown field.'
						)
					);
				const values = yield* Port.attempt('link.import_start', () => validate(start.values)).pipe(
					Effect.flatMap((values) =>
						Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.String))(values).pipe(
							Effect.mapError(() =>
								BoltError.make(
									'bad_answer',
									'facility',
									'The provider returned an invalid import position.'
								)
							)
						)
					)
				);
				if (
					Object.keys(values).some((key) => !capability.fields.some((field) => field.name === key))
				)
					return yield* Effect.fail(
						BoltError.make(
							'bad_answer',
							'facility',
							'The provider returned an unknown import field.'
						)
					);
				return { ...start, values };
			});
		const saveImportStart = (
			instance: string,
			input: ImportStartInput,
			authority: Authority,
			provider_id?: string
		) =>
			Effect.gen(function* () {
				const loaded = yield* h.credentials.read(instance),
					def = yield* definition(loaded.row);
				const provider = pick(
					def.driver,
					provider_id ?? loaded.values.get(PROVIDER),
					loaded.row.owner !== null
				);
				if (provider === undefined)
					return yield* Effect.fail(
						unavailable('Choose a provider before setting the import start.')
					);
				const now = yield* Clock.currentTimeMillis;
				const start = yield* checkedStart(
					provider,
					yield* resolveImportStart(
						input,
						now,
						provider.import_start?.kind === 'timestamp' ? provider.import_start.precision : undefined
					)
				);
				const key = yield* newId;
				const outcome = yield* h.enter(
					Effect.gen(function* () {
						const writes = yield* Writes,
							manifest = yield* Manifest;
						const at = new Date(now).toISOString();
						return (yield* writes.act({
							model: 'sys_integration',
							verb: 'update',
							input: [{ target: instance, set: { import_start: start } }],
							mode: { _tag: 'Direct' },
							key,
							issuedAt: at,
							authority,
							invocationId: key,
							bindings: bindingsAt(now, manifest.workspace.tz)
						})).outcome;
					})
				);
				if (outcome.kind !== 'committed')
					return yield* Effect.fail(
						BoltError.make(
							outcome.kind === 'refused'
								? outcome.code
								: outcome.kind === 'pending_approval'
									? 'pending_approval'
									: 'conflict',
							'admission',
							outcome.kind === 'refused' ? outcome.message : 'The import start was not applied.'
						)
					);
				const held = live.get(instance);
				if (held !== undefined && canonical(held.import_start) !== canonical(start)) {
					held.boundary.changed = true;
					yield* port.changed(instance);
				}
				yield* publish(instance);
			});
		const acquire = (instance: string, provider: Provider, o: Opened) =>
			Effect.gen(function* () {
				const import_start = yield* checkedStart(provider, o.row.import_start);
				const syncs = yield* h.enter(
					Effect.map(Manifest, (manifest) =>
						[...syncs_of(manifest).values()].flatMap((sync) =>
							sync.definition === o.row.integration && sync.read
								? [
										{
											name: sync.name,
											...(sync.partitions === undefined ? {} : { partitions: sync.partitions })
										}
									]
								: []
						)
					)
				);
				const scope = yield* Scope.Scope;
				const tasks = yield* FiberSet.make<unknown, LinkError>();
				const run = yield* FiberSet.runtimePromise(tasks)();
				const launch = yield* FiberSet.runtime(tasks)();
				const signalScope = yield* Effect.acquireRelease(Scope.make(), (owned) =>
					Scope.close(owned, Exit.void)
				);
				const abort = Scope.close(signalScope, Exit.void);
				const signal = yield* Effect.abortSignal.pipe(
					Effect.provideService(Scope.Scope, signalScope)
				);
				let held: HeldState = {
					instance,
					integration: o.row.integration,
					definition: o.definition,
					personal: o.row.owner !== null,
					import_start,
					provider,
					request: isRequest(o.definition.driver),
					epoch: o.epoch,
					values: new Map(o.values),
					status: { state: 'connecting' },
					since: new Date(yield* Clock.currentTimeMillis).toISOString(),
					pairing: null,
					written: null,
					replaced: false,
					boundary: { changed: false },
					flow: { connects: yield* Latch.make(), idle: false },
					stop: abort
				};
				const value = yield* Port.attempt('link', () =>
					provider.open({
						instance,
						definition: o.definition,
						syncs,
						personal: o.row.owner !== null,
						configuration: o.row.configuration,
						import_start,
						webhook_url: webhook_url(h.public_url, instance),
						redirect_url: under(h.public_url, OAUTH_CALLBACK),
						signal,
						// each state() call is a fresh secure nonce
						state: () => Promise.resolve(`${globalThis.crypto.randomUUID()}.${instance}`),
						oauth_client: (vendor) =>
							Promise.resolve(oauth_client_of(o.definition, h.secrets, h.oauth, vendor)),
						fetch: (input, init) =>
							held.replaced
								? Promise.reject(fenced(instance))
								: f(input, {
										...init,
										signal: init?.signal == null ? signal : AbortSignal.any([signal, init.signal])
									}),
						tcp: {
							connect: (endpoint, connecting) =>
								held.replaced
									? Promise.reject(fenced(instance))
									: h.tcp.connect(endpoint, AbortSignal.any([signal, connecting]))
						},
						credentials: {
							load: () =>
								Promise.resolve(new Map([...held.values].filter(([key]) => key !== PROVIDER))),
							write: (changes) =>
								held.replaced
									? Promise.reject(fenced(instance))
									: run(
											changes.has(PROVIDER)
												? Effect.fail(
														BoltError.make(
															'invalid_input',
															'facility',
															`'${PROVIDER}' is the host's credential`
														)
													)
												: persist(held, changes),
											// Returning the fence must survive the lease closure it triggered.
											{ uninterruptible: true }
										).then(() => {})
						},
						emit: (event) =>
							held.replaced
								? Promise.reject(fenced(instance))
								: held.boundary.changed
									? Promise.reject(
											BoltError.make(
												'source_changed',
												'admission',
												'The import start changed; reopen the link before importing.'
											)
										)
									: run(
											h.enter(
												event.kind === 'invalidate'
													? Effect.flatMap(Syncs, (syncs) =>
															syncs.invalidate(instance, event.sync, event.partition)
														)
													: Effect.flatMap(Conversations, (conversations) => {
															held.flow.idle = false;
															return conversations.receive(instance, event, import_start);
														})
											)
										).then(() => {}),
						status: (patch) =>
							held.replaced ? Promise.resolve() : run(report(held, patch)).then(() => {}),
						pairing: (pairing) => {
							if (!held.replaced) {
								held.pairing = pairing;
								launch(logged(moved(held)));
							}
						}
					})
				);
				const calls = linkCalls(value, run, instance);
				const closeProvider = yield* Effect.cached(abort.pipe(Effect.andThen(calls.close)));
				const opened: Held = {
					...held,
					calls,
					stop: Effect.gen(function* () {
						yield* abort;
						const lease = live.get(instance) === opened ? leases.get(instance) : undefined;
						// A credential callback cannot wait for a provider close that drains that same callback.
						yield* FiberSet.run(
							callbacks,
							logged(lease === undefined ? closeProvider : Scope.close(lease, Exit.void))
						);
					})
				};
				held = opened;
				yield* Effect.addFinalizer(() =>
					closeProvider.pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
				);
				if (opened.replaced) return yield* Effect.fail(fenced(instance));
				if (value.renew !== undefined)
					yield* Effect.forkIn(
						Effect.gen(function* () {
							const at = yield* opened.calls.renew.pipe(
								Effect.catch((error) =>
									Effect.logWarning(error).pipe(
										Effect.andThen(Clock.currentTimeMillis),
										Effect.map((now) => new Date(now + 60_000).toISOString())
									)
								)
							);
							if (at === null || opened.replaced) return false;
							const now = yield* Clock.currentTimeMillis;
							yield* Effect.sleep(Math.max(0, Date.parse(at) - now));
							return true;
						}).pipe(Effect.repeat({ until: (again) => !again })),
						scope
					);
				if (value.reconcile !== undefined) yield* Effect.forkIn(reconciling(opened), scope);
				return opened;
			});
		const map = yield* RcMap.make({
			lookup: (instance: string) =>
				Effect.gen(function* () {
					const chosen = selected.get(instance);
					if (chosen !== undefined) return yield* acquire(instance, chosen.provider, chosen.opened);
					const loaded = yield* h.credentials.open(instance);
					const def = yield* definition(loaded.row);
					const provider = pick(def.driver, loaded.values.get(PROVIDER), loaded.row.owner !== null);
					if (provider === undefined || loaded.values.get(PROVIDER) === undefined)
						return yield* Effect.fail(
							unavailable(`this host has no registered provider for '${instance}'`)
						);
					return yield* acquire(instance, provider, { ...loaded, definition: def });
				})
		});
		const shut = (instance: string) =>
			Effect.gen(function* () {
				live.delete(instance);
				const lease = leases.get(instance);
				leases.delete(instance);
				if (lease !== undefined) yield* Scope.close(lease, Exit.void);
				yield* RcMap.invalidate(map, instance);
			});
		const start = (instance: string) =>
			Effect.gen(function* () {
				if (live.has(instance)) return;
				const lease = yield* Scope.make();
				const opened = yield* RcMap.get(map, instance).pipe(
					Effect.provideService(Scope.Scope, lease),
					Effect.onError(() => Scope.close(lease, Exit.void).pipe(Effect.andThen(RcMap.invalidate(map, instance))))
				);
				leases.set(instance, lease);
				live.set(instance, opened);
				yield* moved(opened);
				yield* resumeSends(opened);
			});
		/** Re-read durable state before each reopen; an account may be paused, removed or unpaired during startup. */
		const restore = (instance: string) => Effect.gen(function* () {
			const current = yield* row(instance);
			if (current?.active === true && current.stored && !isRequest(current.definition.driver))
				yield* start(instance);
		});
		const retryOpening = (error: EngineError | PortFailure): boolean => {
			if (stopped) return false;
			switch (error._tag) {
				case 'FacilityFailure': return error.kind === 'upstream' || error.kind === 'timeout';
				case 'Unavailable':
				case 'Fenced': return false;
				case 'BoltError': return error.code !== 'fenced' && is_transient(error);
				default: return (error._tag === 'DbError' && error.sqlstate.startsWith('08')) || is_transient(error);
			}
		};
		const linked = (instance: string) =>
			Effect.suspend((): Effect.Effect<Held, BoltError | Fenced> => {
				const held = live.get(instance);
				return held === undefined
					? Effect.fail(unavailable(`'${instance}' is not connected`))
					: held.replaced
						? Effect.fail(fenced(instance))
						: Effect.succeed(held);
			});
		const transient = <A, E>(instance: string, use: (held: Held) => Effect.Effect<A, E>) =>
			Effect.scoped(
				Effect.gen(function* () {
					if (stopped) return yield* Effect.fail(unavailable('the integration links are closed'));
					const loaded = yield* h.credentials.read(instance),
						def = yield* definition(loaded.row);
					const provider = pick(def.driver, loaded.values.get(PROVIDER), loaded.row.owner !== null);
					if (provider === undefined)
						return yield* Effect.fail(unavailable(`this host has no provider for '${instance}'`));
					return yield* use(yield* acquire(instance, provider, { ...loaded, definition: def }));
				})
			);
		/**
		 * A valid workspace conversation account waits for its initial pairing or reconnect (`LINK_DOWN`). Its durable
		 * queue is resumed by the connected transition, independently from this host's in-memory link state.
		 */
		const sending = (instance: string) =>
			Effect.gen(function* () {
				const held = live.get(instance);
				if (held?.replaced !== true) {
					if (held?.status.state === 'connected') {
						held.flow.idle = false;
						return held;
					}
					const current = yield* row(instance);
					if (current === undefined || current.personal || !conversational(current.definition))
						return yield* Effect.fail(new FacilityFailure({ kind: 'invalid', message: `'${instance}' is not a workspace conversation account` }));
					return yield* Effect.fail(
						new Unavailable({ facility: LINK_DOWN, reason: `'${instance}' is not connected` })
					);
				}
				return yield* linked(instance);
			});
		const port: Drivers['Service'] = {
			available: true,
			send: (instance, message, attachments) =>
				sending(instance).pipe(
					Effect.mapError(linkFailure(instance)),
					Effect.flatMap((held) => held.calls.send(message, attachments))
				),
			typing: (instance, to, on) =>
				linked(instance).pipe(
					Effect.mapError(Port.failure('link')),
					Effect.flatMap((held) => held.calls.typing(to, on))
				),
			// a request driver opens a link per call; a pushing driver's call (a calendar write) goes through its standing link
			request: (instance, op) =>
				Effect.gen(function* () {
					const x = yield* row(instance);
					if (x !== undefined && !isRequest(x.definition.driver))
						return yield* linked(instance).pipe(Effect.flatMap((held) => held.calls.request(op)));
					return yield* transient(instance, (held) => held.calls.request(op));
				}).pipe(Effect.mapError(linkFailure(instance))),
			read: (instance, feed, partition, cursor) =>
				linked(instance).pipe(
					Effect.mapError(Port.failure('link')),
					Effect.flatMap((held) => held.calls.read(feed, partition, cursor))
				),
			changed: (instance) =>
				serial(
					instance,
					Effect.gen(function* () {
						const held = live.get(instance);
						if (held?.request === true || held?.replaced === true) return;
						yield* shut(instance);
						yield* restore(instance);
					})
				).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
		};
		const custom = (instance: string, request: Request) =>
			Effect.gen(function* () {
				const found = yield* h.credentials
					.read(instance)
					.pipe(
						Effect.catchTag('BoltError', (error) =>
							error.code === 'not_found' ? Effect.succeed(undefined) : Effect.fail(error)
						)
					);
				if (found === undefined) return new Response(null, { status: 404 });
				const d = yield* definition(found.row);
				if (d.webhook === undefined) return new Response(null, { status: 404 });
				if (!found.row.active) return new Response(null, { status: 503 });
				const credential = found.values.get('credential'),
					secret = Predicate.isObject(credential) ? credential[d.webhook.verify.secret] : undefined;
				if (typeof secret !== 'string' || secret === '') return new Response(null, { status: 401 });
				const headers = Object.fromEntries(request.headers),
					body = new Uint8Array(yield* Port.attempt('webhook', () => request.arrayBuffer()));
				const now = yield* Clock.currentTimeMillis;
				const verified = verifiedWebhook(
					d.webhook.verify.scheme,
					secret,
					{
						method: request.method,
						headers,
						query: Object.fromEntries(new URL(request.url).searchParams),
						body
					},
					now
				);
				if ('answer' in verified)
					return new Response(verified.answer.body ?? null, { status: verified.answer.status });
				if (verified.body === undefined) return new Response(null, { status: 400 });
				const { authorization: _, ...shown } = headers;
				yield* h.admit(
					Effect.flatMap(Syncs, (syncs) =>
						syncs.hint(instance, {
							kind: 'webhook',
							id: verified.delivery,
							at: new Date(now).toISOString(),
							body: verified.body ?? null,
							headers: shown
						})
					)
				);
				return new Response(null, { status: 200 });
			});
		const webhook = (instance: string, request: Request) => {
			const held = live.get(instance);
			return (
				held !== undefined && !held.replaced
					? held.calls
							.webhook(request)
							.pipe(Effect.catchTag('Unavailable', () => custom(instance, request)))
					: custom(instance, request)
			).pipe(
				Effect.tapCause(Effect.logWarning),
				Effect.catch(() => Effect.succeed(new Response(null, { status: 500 })))
			);
		};
		const close = Effect.gen(function* () {
			if (stopped) return;
			stopped = true;
			yield* Effect.forEach([...leases.keys()], shut, { concurrency: 'unbounded' });
			yield* FiberSet.awaitEmpty(callbacks);
			yield* PubSub.shutdown(events);
		});
		yield* Effect.addFinalizer(() => close);
		return {
			port,
			close,
			resume: h
				.enter(
					Effect.gen(function* () {
						const db = yield* TenantDb;
						const manifest = yield* Manifest;
						const rows = yield* db.rows(
							Schema.Struct({ id: Schema.String, integration: Schema.String }),
							{
								text: `SELECT i.id, i.integration FROM sys_integration i WHERE i.active AND EXISTS (SELECT 1 FROM bolt_credential c WHERE c.instance = i.id AND c.name = $1) ORDER BY i.id`,
								params: [PROVIDER]
							}
						);
						return rows.flatMap((x) => {
							const d = definitionOf(manifest, x.integration);
							return d === undefined || isRequest(d.driver) ? [] : [x.id];
						});
					})
				)
				.pipe(
					Effect.flatMap((ids) =>
						Effect.gen(function* () {
							const results = yield* Effect.forEach(ids, (instance) =>
								serial(instance, restore(instance)).pipe(
									Effect.retry({ times: 4, while: retryOpening,
										schedule: Schedule.min([Schedule.exponential('100 millis'), Schedule.spaced('5 seconds')]) }),
									Effect.tapError((error) => Effect.logWarning(error)),
									Effect.result
								), { concurrency: 'unbounded' });
							// an instance this host cannot serve (no registered provider) stays closed; it does not fail the resume
							const failure = results.find((result) => Result.isFailure(result)
								&& !(result.failure._tag === 'BoltError' && result.failure.code === 'unavailable'));
							if (failure !== undefined && Result.isFailure(failure)) return yield* Effect.fail(failure.failure);
						})
					)
				),
			state,
			offers: h.enter(
				Effect.map(Manifest, (manifest) =>
					[
						...Object.entries(SYSTEM.integrations).filter(
							([name]) => !Object.hasOwn(manifest.integrations, name)
						),
						...Object.entries(manifest.integrations)
					].map(([integration, definition]): IntegrationOffer => ({
						integration,
						driver: definition.driver,
						description: definition.description,
						conversation: conversational(definition),
						personal: 'personal' in DRIVERS[definition.driver] ? offered(definition, true) : [],
						workspace: offered(definition, false)
					}))
				)
			),
			watch: (instance) =>
				Stream.unwrap(
					Effect.gen(function* () {
						const subscription = yield* PubSub.subscribe(events);
						yield* Effect.acquireRelease(
							Effect.sync(() => {
								watchers++;
							}),
							() =>
								Effect.sync(() => {
									watchers--;
								})
						);
						const ids =
							instance === undefined
								? yield* h
										.enter(
											Effect.flatMap(TenantDb, (db) =>
												db.rows(Schema.Struct({ id: Schema.String }), {
													text: 'SELECT id FROM sys_integration ORDER BY id',
													params: []
												})
											)
										)
										.pipe(Effect.map((rows) => rows.map((row) => row.id)))
								: [instance];
						const initial = yield* Effect.forEach(ids, state);
						return Stream.concat(
							Stream.fromArray(initial.filter((value) => value !== undefined)),
							Stream.fromSubscription(subscription).pipe(
								Stream.filter((value) => instance === undefined || value.instance === instance)
							)
						);
					})
				),
			import_start: (instance, input, authority) => saveImportStart(instance, input, authority),
			pair: (instance, input, authority) =>
				Effect.gen(function* () {
					if (Predicate.isObject(input) && input['import_start'] !== undefined) {
						if (authority === undefined)
							return yield* Effect.fail(
								BoltError.make('forbidden', 'admission', 'Sign in to change the import start.')
							);
						const start = yield* Schema.decodeUnknownEffect(ImportStartInput)(
							input['import_start']
						).pipe(
							Effect.mapError(() =>
								BoltError.make('invalid_input', 'decode', 'Choose a valid import start.')
							)
						);
						yield* saveImportStart(
							instance,
							start,
							authority,
							typeof input['provider'] === 'string' ? input['provider'] : undefined
						);
					}
					return yield* serial(
						instance,
						Effect.gen(function* () {
							const x = yield* row(instance);
							if (x === undefined) return yield* Effect.fail(gone(instance));
							const body = Predicate.isObject(input) ? input : {},
								ps = choices(x.definition.driver, x.personal);
							if (ps.length === 0)
								return yield* Effect.fail(
									unavailable(`this host has no registered ${x.definition.driver} provider`)
								);
							const provider =
								typeof body['provider'] === 'string'
									? ps.find((p) => p.id === body['provider'])
									: ps.length === 1
										? ps[0]
										: undefined;
							if (provider === undefined)
								return yield* Effect.fail(
									BoltError.make(
										'invalid_input',
										'facility',
										`choose how to connect this ${x.definition.driver} instance: ${ps.map((p) => p.id).join(', ')}`
									)
								);
							const { provider: _, import_start: _start, ...rest } = body;
							const current = live.get(instance);
							if (
								x.definition.driver !== 'sqlserver' &&
								current !== undefined &&
								current.provider.id === provider.id &&
								!current.replaced
							) {
								yield* current.calls.pair(rest).pipe(Effect.ensuring(logged(publish(instance))));
								return;
							}
							yield* shut(instance);
							const loaded = yield* h.credentials.open(instance);
							const fresh =
								loaded.values.get(PROVIDER) !== provider.id || current?.replaced === true;
							const epoch =
								fresh && loaded.values.size > 0
									? yield* h.credentials.write(
											instance,
											loaded.epoch,
											wipe(loaded.values.keys()),
											isRequest(x.definition.driver)
										)
									: loaded.epoch;
							selected.set(instance, {
								provider,
								opened: {
									epoch,
									row: loaded.row,
									values: fresh ? new Map() : loaded.values,
									definition: x.definition
								}
							});
							yield* start(instance).pipe(
								Effect.ensuring(
									Effect.sync(() => {
										selected.delete(instance);
									})
								)
							);
							const next = yield* linked(instance);
							const database = x.definition.driver === 'sqlserver';
							if (database)
								yield* status(instance, {
									state: 'unpaired',
									databaseVerified: false,
									error: null,
									code: null
								});
							yield* next.calls.pair(rest).pipe(
								Effect.andThen(persist(next, new Map([[PROVIDER, provider.id]]))),
								Effect.andThen(
									database ? verifyDatabase(instance, next.calls.test(null)) : Effect.void
								),
								Effect.onError(() =>
									shut(instance).pipe(
										Effect.andThen(logged(persist(next, wipe(next.values.keys())))),
										Effect.andThen(logged(publish(instance)))
									)
								)
							);
							if (next.request && next.status.state !== 'pairing') yield* shut(instance);
							yield* publish(instance);
						})
					);
				}),
			unpair: (instance) =>
				serial(
					instance,
					Effect.gen(function* () {
						const held = live.get(instance);
						// the provider forgets this host first (a linked device logs out, a grant is revoked) …
						if (held !== undefined && !held.replaced)
							yield* held.calls.unpair.pipe(Effect.ensuring(shut(instance)));
						else yield* shut(instance);
						// … then every stored credential goes, after the link closed: a close that flushes keys cannot rewrite them
						const loaded = yield* h.credentials.open(instance);
						yield* h.credentials.write(instance, loaded.epoch, wipe(loaded.values.keys()));
						yield* status(instance, {
							state: 'unpaired',
							databaseVerified: false,
							account: null,
							error: null,
							code: null,
							last_disconnect: null
						});
						yield* publish(instance);
					})
				),
			test: (instance, input) =>
				serial(
					instance,
					Effect.gen(function* () {
						const x = yield* row(instance);
						if (x === undefined) return yield* Effect.fail(gone(instance));
						if (x.definition.driver === 'sqlserver')
							return yield* verifyDatabase(
								instance,
								transient(instance, (held) => held.calls.test(input))
							);
						if (conversational(x.definition) && !isRequest(x.definition.driver)) {
							if (x.personal)
								return yield* Effect.fail(
									BoltError.make(
										'invalid_input',
										'facility',
										'A personal account sends no test message.'
									)
								);
							if (!live.has(instance) && choices(x.definition.driver, false).length === 0)
								return yield* Effect.fail(
									unavailable(`this host has no registered provider for '${instance}'`)
								);
							if (!live.has(instance))
								return yield* Effect.fail(
									BoltError.make(
										'invalid_input',
										'facility',
										'this integration cannot send a test message now'
									)
								);
							const held = yield* linked(instance);
							if (held.status.state !== 'connected' || held.provider.test === undefined)
								return yield* Effect.fail(
									BoltError.make(
										'invalid_input',
										'facility',
										'this integration cannot send a test message now'
									)
								);
							const to =
								held.provider.test.to === undefined
									? held.status.account
									: Predicate.isObject(input) && typeof input['to'] === 'string'
										? input['to'].trim()
										: undefined;
							yield* held.calls.test(input).pipe(
								Effect.catchTag('Unavailable', (): Effect.Effect<void, LinkError> =>
									Effect.gen(function* () {
										if (to === undefined)
											return yield* Effect.fail(
												BoltError.make(
													'invalid_input',
													'facility',
													'name where the test message goes'
												)
											);
										const id = yield* newId;
										yield* held.calls.send(
											x.definition.driver === 'email'
												? {
														id,
														to: [to],
														subject: 'Norbital test message',
														text: TEST_TEXT
													}
												: { id, to, text: TEST_TEXT }
										);
									})
								)
							);
						} else if (isRequest(x.definition.driver))
							yield* transient(instance, (held) => held.calls.test(input));
						else yield* linked(instance).pipe(Effect.flatMap((held) => held.calls.test(input)));
						yield* testSync(instance);
					})
				).pipe(Port.call('link.test', 60_000)),
			discover: (instance) =>
				serial(
					instance,
					Effect.gen(function* () {
						const x = yield* row(instance);
						if (x === undefined) return yield* Effect.fail(gone(instance));
						return yield* isRequest(x.definition.driver)
							? transient(instance, (held) => held.calls.discover)
							: linked(instance).pipe(Effect.flatMap((held) => held.calls.discover));
					})
				),
			may: (authority, instance) =>
				h.enter(
					Effect.gen(function* () {
						const manifest = yield* Manifest;
						const db = yield* TenantDb;
						const guest = yield* Guest;
						const bindings = bindingsAt(yield* Clock.currentTimeMillis, manifest.workspace.tz);
						// the instance's update checks judge a host verb on it
						return yield* mayUpdate(
							{ manifest, db, guest },
							'sys_integration',
							instance,
							authority,
							bindings
						);
					})
				),
			webhook,
			callback: (request) => {
				const state = new URL(request.url).searchParams.get('state') ?? '',
					dot = state.indexOf('.');
				const held = dot < 0 ? undefined : live.get(state.slice(dot + 1));
				return held === undefined || held.replaced
					? Effect.succeed(new Response(EXPIRED, { status: 400 }))
					: webhook(held.instance, request);
			}
		};
	});

export const LinksLive = Layer.effect(
	Links,
	Effect.gen(function* () {
		const drivers = yield* Drivers;
		const context = yield* Effect.context<TenantDb | Manifest | Live | Wake>();
		return {
			open: (instance: string) =>
				drivers.changed(instance).pipe(Effect.mapError((error) => unavailable(error.reason))),
			close: () => Effect.void,
			changed: (instance: string) =>
				drivers.changed(instance).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore),
			typing: drivers.typing,
			send: drivers.send,
			request: drivers.request,
			status: (instance: string, patch: { readonly [key: string]: Json }) =>
				writeStatus(instance, patch).pipe(Effect.provideContext(context))
		};
	})
);
