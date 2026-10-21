// HOST_API (D10a), `@norbital-ai/bolt/host-api`: the one surface between a host on another module graph and this release.
// A host loads each workspace's pinned Bolt from that release's own pnpm graph, whose `effect` is another copy: an Effect,
// Layer or service key of one copy is not one of the other. So the contract is plain: Promise + AbortSignal +
// Schema-encoded JSON, failures included. `Request`, `Response`, `AbortSignal` and `Uint8Array` are the realm's own and
// cross as they are; a port is a record of Promise functions. Same-graph hosts (bolt-server, `bolt dev`, the kit) compose
// Bolt's layers directly; `host-api.conformance.integration.test.ts` runs one slice through both entries.
//
// Two rules at the edge: an answer the host interprets rejects with an encoded `HostApiFailure`, never this release's
// class; a port the host only relays back (`WorkspaceLinks.port`) keeps this release's own failures. A host port's
// encoded `HostFailure` becomes this release's `BoltError` where the shell or the links branch on its code.
import {
	Clock,
	Config,
	ConfigProvider,
	Context,
	Crypto,
	Effect,
	FiberSet,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
	Result,
	Schema
} from 'effect';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse';
import type { Json } from '../decl/values.ts';
import type { Holder } from '../engine/access/authority.ts';
import { Authorities } from '../engine/identity/actor.ts';
import { RateWindows } from '../engine/access/rate.ts';
import {
	founderBootstrap,
	loadKeys,
	makeIdentityHost,
	mint,
	signupOf,
	type IdentityHost
} from '../engine/identity/session.ts';
import { Conflict, DbError, Fenced, Interrupted, type EngineError } from '../engine/errors.ts';
import { BoltError, CODES, PHASES } from './errors.ts';
import type {
	Authority,
	HostPorts as EnginePorts,
	Invocation,
	LinksPort,
	Lock,
	Rows,
	Sql,
	TransportPort
} from '../engine/contracts.ts';
import { PostgresDb, type PgPool } from '../engine/db/postgres.ts';
import { PgliteDb, type PgliteClient } from '../engine/db/pglite.ts';
export type { PgliteClient } from '../engine/db/pglite.ts';
import { TenantDb, TenantTx, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { EngineLive, type EngineServices, type EngineHost } from '../engine/host.ts';
import { Activation, Conversations, Feeds, Manifest, Runs } from '../engine/services.ts';
import {
	Ai,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	Metering,
	Speech,
	Transport,
	WebRead
} from '../engine/ports.ts';
import { declaredSecrets } from '../engine/manifest.ts';
import { Secrets } from '../engine/secrets.ts';
import { GuestConfig } from '../engine/guest/runner.ts';
import { AgentHost, type AgentConfig } from '../engine/agent/index.ts';
import { HOOKS, OAUTH_CALLBACK, integrationLinks } from '../engine/integrations/links.ts';
import { credentials } from '../engine/integrations/credentials.ts';
import type { OAuthClient, OAuthVendor, Provider } from '../engine/integrations/driver.ts';
import type { SchemaSlice } from '../engine/schema/ddl.ts';
import { applyPlan, plan, readApplied, schemaSlice } from '../engine/schema/plan.ts';
import { loadPack, readPack } from '../engine/write/pack.ts';
import { Port } from '../engine/port.ts';
import {
	authorityOf,
	HostIdentity,
	ShellConfig,
	ShellRoutes,
	Turnstile,
	type ShellHostConfig
} from '../shell/host.ts';
import { COOKIES, cookieSite, framePolicy } from '../shell/nav.ts';
import {
	loadPackWithAssets,
	readArtifact,
	workspaceFiles,
	CONTRACT,
	type Artifact
} from '../engine/artifact/read.ts';
import { needsGuest, RateLimits, SessionAuthority } from './http.ts';
import { BoltHost, BoltHostLive } from './host.ts';
import { PublicPages, publicPages } from './pages.ts';
export { renderMode } from './pages.ts';
import { IntegrationManager, integrationRoutes } from './integrations.ts';

/** Bumped on any change a host on an older copy could misread; the host refuses a release whose `version` differs. */
export const HOST_API_VERSION = 3;

// ── failures (D10a) ──
/** A `BoltError` this release raised: an engine answer. `code` stays a string on the wire (the copies' code sets may differ). */
export const HostFailure = Schema.TaggedStruct('HostFailure', {
	code: Schema.String,
	phase: Schema.Literals(PHASES),
	message: Schema.String
});
export type HostFailure = typeof HostFailure.Type;
/** Anything else: the database went away, a host port threw. The host may retry it elsewhere; an engine answer stands. */
export const HostDefect = Schema.TaggedStruct('HostDefect', { message: Schema.String });
export type HostDefect = typeof HostDefect.Type;
export const HostApiFailure = Schema.Union([HostFailure, HostDefect]);
export type HostApiFailure = typeof HostApiFailure.Type;

// ── answers the host interprets ──
/** `session.mint` (the apex handoff): the host sets `cookies.session` to `token` until `expiresAt`. */
export const MintedSession = Schema.Struct({
	token: Schema.String,
	user: Schema.String,
	expiresAt: Schema.String
});
export type MintedSession = typeof MintedSession.Type;
/** `founder.bootstrap` (§5.11.3): the first administrator, or the identity refusal (`forbidden`: one exists already). */
export const FounderAnswer = Schema.Union([
	Schema.TaggedStruct('Founded', { user: Schema.String }),
	Schema.TaggedStruct('FounderRefused', { code: Schema.String, message: Schema.String })
]);
export type FounderAnswer = typeof FounderAnswer.Type;

// ── what the host hands over ──
export type Signal = { readonly signal: AbortSignal };
/** A built workspace: `bolt build`'s directory, with source, format and digests verified by this release. */
export type Release = {
	readonly dir: string;
	/** The host's release id (the artifact digest it records): authorities are compiled per release (rule 37). */
	readonly id: string;
};
/**
 * The environment's database. Cross-graph hosts hand a native node-postgres pool or PGlite client, which this release
 * wraps with its own adapter and `DbError` identities. Same-graph hosts may hand a `TenantDbShape` this release built.
 * The host owns the native driver's lifetime; PGlite clients use the configured parsers and UTC session from `PgliteDb.open`.
 */
export type HostDatabase =
	| { readonly _tag: 'Pool'; readonly pool: PgPool }
	| { readonly _tag: 'Pglite'; readonly client: PgliteClient }
	| { readonly _tag: 'Tenant'; readonly db: TenantDbShape };
/** The environment's database as a cross-graph port receives it (D10a): Promise + AbortSignal; failures are this release's `DbError`. */
export type HostTenantDb = {
	read(statements: readonly Sql[], signal?: AbortSignal): Promise<readonly Rows[]>;
	write(statement: Sql, lock?: Lock, signal?: AbortSignal): Promise<Rows>;
	transaction<T>(
		body: (tx: { query(statement: Sql): Promise<Rows> }) => Promise<T>,
		lock?: Lock
	): Promise<T>;
};
export type HostCredentials = {
	readonly open: (instance: string) => Promise<{
		epoch: string;
		row: {
			integration: string;
			owner: string | null;
			active: boolean;
			configuration: Json;
			import_start?: Json;
		};
		values: ReadonlyMap<string, Json>;
	}>;
	readonly read: (instance: string) => Promise<{
		epoch: string | null;
		row: {
			integration: string;
			owner: string | null;
			active: boolean;
			configuration: Json;
			import_start?: Json;
		};
		values: ReadonlyMap<string, Json>;
	}>;
	readonly write: (
		instance: string,
		epoch: string | null,
		changes: ReadonlyMap<string, Json | null>,
		rotate?: boolean
	) => Promise<string | null>;
};
/** The shell's host parts (§5.10); `studio` and `organization.write` may reject with an encoded `HostFailure`. */
export type ShellPorts = Pick<
	ShellHostConfig,
	| 'workspace'
	| 'studio'
	| 'push'
	| 'notice'
	| 'environment'
	| 'apex'
	| 'live'
	| 'workspaces'
	| 'organization'
	| 'ai'
>;
/** The agent's host parts (§5.9); the release's source (`workspace_search`) and attachments are this release's own. */
export type AgentPorts = Pick<AgentConfig, 'draft' | 'sandbox' | 'hostTools' | 'skills'>;
/** One serving generation of an environment. */
export type HostPorts = Pick<
	EnginePorts,
	| 'files'
	| 'deadlines'
	| 'convert'
	| 'ai'
	| 'speech'
	| 'geocoder'
	| 'web'
	| 'links'
	| 'metering'
	| 'membership'
> & {
	/** Rule 61: this environment's epoch (a fork's rows are never sent). */
	readonly epoch?: string;
	/** Each guest invocation's CPU, once it settles, with its crossings and statements (the host bills compute). */
	readonly cpu?: (
		invocation: Invocation,
		cpuMs: number,
		counts: { readonly crossings: number; readonly statements: number }
	) => void;
	/** One native execution slice; release follows native settlement, before waiting for host I/O. */
	readonly compute?: (options: Signal) => Promise<() => Promise<void>>;
	/** Background isolate preparation acquires host capacity, released only after preparation/disposal settles. */
	readonly warmPreparation?: (options: Signal) => Promise<() => Promise<void>>;
} & {
	/** `<tenant>/<environment>`: the deadlines scope and the log key. */
	readonly scope: string;
	readonly release: Release;
	readonly database: HostDatabase;
	/** The workspace's public URL with its path prefix (`https://host/acme`), no trailing slash. */
	readonly publicUrl: string;
	/** Rule 70: the seed pack's `start` runs, queued once on the environment's first admission. */
	readonly start?: readonly string[];
	/** §5.11.4: the tenant's 32-byte secrets key; absent, no declared secret has a value. */
	readonly secretsKey?: Uint8Array;
	/** Web push for inbox notices, over the environment's database (a gone subscription is deleted there). */
	readonly push?: (db: HostTenantDb) => TransportPort;
	readonly identity: Pick<IdentityHost, 'mail' | 'sms' | 'phone' | 'devSink'>;
	readonly shell: ShellPorts;
	readonly agent: AgentPorts;
};
/** A branch the lifecycle prepares outside any serving generation (provision, reset, probe, restore). */
export type BranchPorts = { readonly release: Release; readonly database: HostDatabase };
/** An environment's integration links (§4.5): they outlive idle generations and re-enter the current one. */
export type LinkHost = {
	readonly release: Release;
	readonly database: HostDatabase;
	readonly secretsKey?: Uint8Array;
	/** As `HostPorts.publicUrl`: every webhook URL and the OAuth callback are under it. */
	readonly publicUrl: string;
	readonly providers: readonly Provider[];
	/** The host's OAuth clients (Google), signing in every definition that names none of its own. */
	readonly oauth?: Partial<Record<OAuthVendor, OAuthClient>>;
	/** Runs `work` on the scope's current generation, outside compute admission (a link's ingest). */
	enter<T>(work: (workspace: ActiveWorkspace) => Promise<T>): Promise<T>;
	/** As `enter`, admitted under the compute envelope (a guest body: a custom conversation's webhook, a test send). */
	admit<T>(work: (workspace: ActiveWorkspace) => Promise<T>): Promise<T>;
	/** FINAL §4.5: wraps the sealed credentials the links write through, so credential I/O can survive a retirement. */
	credentials?(sealed: HostCredentials): HostCredentials;
	readonly fetch?: typeof fetch;
	log?(line: string): void;
};

// ── what the host gets ──
export type ActiveWorkspace = {
	/**
	 * Bolt's routes for this generation, the request as the workspace sees it (no host prefix): the shell host
	 * (`/__bolt/session/*`, `/__bolt/shell*`, the PWA manifest), files, the data protocol and `/hooks/<path>` automation
	 * webhooks; `null` when none is Bolt's. Event streams end when the generation closes.
	 */
	handle(request: Request, options: { readonly address: string }): Promise<Response | null>;
	/** Protected public-page loading and HTML rendering share one read-only guest invocation. */
	render(
		request: Request,
		options: Signal & { readonly address: string }
	): Promise<Response | null>;
	/** One deadline wake (rule 52a): every due run of the environment, then `deadlines.settle`. */
	wake(options: Signal): Promise<void>;
	/** Rule 71a: interrupts every guest invocation and in-flight crossing of this generation; the host then ends its pool. */
	close(): Promise<void>;
	readonly identity: {
		/** The caller's compiled authority from the request's session, or `null`. */
		authority(request: Request, options: Signal): Promise<Authority | null>;
		/** `session.mint` for an active member; `null` for none. */
		mint(user: string, options: Signal): Promise<MintedSession | null>;
	};
};
export type WorkspaceBranch = {
	readonly schema: {
		/** Engine tables, then the release's schema plan (rule 69; destructive steps only when accepted). */
		migrate(options: Signal & { readonly accept?: true | readonly string[] }): Promise<void>;
	};
	readonly packs: {
		/** Rule 70: a seed pack directory (`seed/<pack>`), its assets into `files` when given; `false`: the branch had rows. */
		load(
			pack: string,
			options: Signal & { readonly at: string; readonly files?: EnginePorts['files'] }
		): Promise<boolean>;
	};
	readonly identity: {
		founder(address: string, options: Signal & { readonly at: string }): Promise<FounderAnswer>;
	};
	readonly integrations: {
		/** FINAL §4.5: a restored branch's session instances lose their credentials and read `unpaired`. */
		unpairSessions(options: Signal): Promise<void>;
	};
};
export type WorkspaceLinks = {
	/** Relayed, not interpreted: hand it to `activate` as `links`; its failures are this release's own. */
	readonly port: LinksPort;
	/** The sealed credentials the links write through, failures encoded (another owner's `LinkHost.credentials` may retry here). */
	readonly credentials: HostCredentials;
	/** Reopens every active, paired instance this host's providers serve. */
	resume(options: Signal): Promise<void>;
	/** Closes every link; status streams end. The host then ends its pool. */
	close(): Promise<void>;
	/** `/hooks/integration/<instance>…` and `/hooks/oauth/callback`, the request as the workspace sees it; `null` otherwise. */
	hook(request: Request): Promise<Response | null>;
	/** `/__bolt/integrations/*` for an authorized caller; `null` otherwise. */
	admin(request: Request, authority: Authority): Promise<Response | null>;
};
export type HostApi = {
	/** Hosts admit only runtimes that evaluate tenant source without restoring native snapshots. */
	readonly guestExecution: 'source';
	/** `HOST_API_VERSION` of the release that answers. */
	readonly version: number;
	/** The artifact contract this release implements (rule 69). */
	readonly contract: string;
	readonly cookies: { readonly session: string; readonly preview: string };
	/** The session cookie's site attributes. */
	cookieSite(secure: boolean): string;
	/** Rule 71: whether a request may run a guest body, so the host admits only these under its compute envelope. */
	needsGuest(request: Request): Promise<boolean>;
	/** Refuses an artifact this release did not build or whose files do not match their digests. */
	verify(release: Release, options: Signal): Promise<void>;
	/** The client page's `frame-ancestors` policy for `path`. */
	framePolicy(release: Release, path: string, options: Signal): Promise<string>;
	/** The host's own authority over a workspace (signed operations, Studio as the host). */
	authority(release: Release, holder: Holder, key: string, options: Signal): Promise<Authority>;
	readonly schema: {
		/** The schema state the release plans from (X-16: what a successor's plan is diffed against). */
		slice(release: Release, options: Signal): Promise<SchemaSlice>;
		/** The destructive steps planning `release` over `applied` (another release's `slice`) would take. */
		destructive(
			applied: SchemaSlice,
			release: Release,
			options: Signal
		): Promise<readonly string[]>;
	};
	activate(ports: HostPorts, options: Signal): Promise<ActiveWorkspace>;
	branch(ports: BranchPorts, options: Signal): Promise<WorkspaceBranch>;
	links(host: LinkHost, options: Signal): Promise<WorkspaceLinks>;
};

// ── the implementation: the only cross-module-graph edge ──
const encode = (error: unknown): HostApiFailure => {
	if (error instanceof BoltError)
		return { _tag: 'HostFailure', code: error.code, phase: error.phase, message: error.message };
	if (typeof error === 'object' && error !== null && '_tag' in error) {
		if (error._tag === 'Fenced' && 'message' in error)
			return {
				_tag: 'HostFailure',
				code: 'fenced',
				phase: 'facility',
				message: String(error.message)
			};
		if (error._tag === 'Interrupted')
			return {
				_tag: 'HostFailure',
				code: 'interrupted',
				phase: 'admission',
				message: 'The workspace generation is closed.'
			};
		if (error._tag === 'Conflict')
			return {
				_tag: 'HostFailure',
				code: 'conflict',
				phase: 'commit',
				message: 'Another write changed these records.'
			};
		if (error._tag === 'IdentityRefusal' && 'code' in error && 'message' in error)
			return {
				_tag: 'HostFailure',
				code: String(error.code),
				phase: 'admission',
				message: String(error.message)
			};
	}
	return { _tag: 'HostDefect', message: error instanceof Error ? error.message : String(error) };
};
const guard = <A>(work: () => Promise<A>): Promise<A> =>
	Promise.resolve()
		.then(work)
		.catch((error: unknown) =>
			Promise.reject(Schema.encodeUnknownSync(HostApiFailure)(encode(error)))
		);
const isFailure = Schema.is(HostFailure),
	isCode = Schema.is(Schema.Literals(CODES));
const hosted = <A>(work: () => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: (error) =>
			error instanceof BoltError ||
			error instanceof Conflict ||
			error instanceof DbError ||
			error instanceof Fenced ||
			error instanceof Interrupted
				? error
				: isFailure(error)
					? BoltError.make(isCode(error.code) ? error.code : 'internal', error.phase, error.message)
					: BoltError.make('upstream', 'facility', String(error))
	});
const database = (db: HostDatabase): TenantDbShape =>
	db._tag === 'Pool'
		? PostgresDb.make(db.pool)
		: db._tag === 'Pglite'
			? PgliteDb.make(db.client)
			: db.db;
/** Artifact inspection has no tenant services; activation owns its own runtime below. */
const inspection = ManagedRuntime.make(NodeServices.layer);
const artifactOf = (release: Release, options: Signal) =>
	inspection.runPromise(Effect.result(readArtifact(release.dir)), options).then(Result.getOrThrow);
const activeRuns = new WeakMap<
	ActiveWorkspace,
	<A, E>(effect: Effect.Effect<A, E, EngineServices | EngineHost>) => Promise<A>
>();
const activation = (ports: HostPorts, artifact: Artifact) =>
	Layer.succeed(Activation, {
		scope: ports.scope,
		epoch: ports.epoch ?? '',
		release: ports.release.id,
		publicUrl: ports.publicUrl,
		guest: Option.some(artifact.guest),
		transforms: new Set(artifact.transforms),
		projections: new Set(artifact.projections),
		start: ports.start ?? [],
		secretsKey:
			ports.secretsKey === undefined ? Option.none() : Option.some(Redacted.make(ports.secretsKey))
	});
/** Host-provided records cross only this explicit Promise ABI adapter. */
const portLayers = (ports: HostPorts) =>
	Layer.mergeAll(
		Files.fromAbi(ports.files),
		Convert.fromAbi(ports.convert),
		Speech.fromAbi(ports.speech),
		WebRead.fromAbi(ports.web),
		Geo.fromAbi(ports.geocoder),
		Metering.fromAbi(ports.metering),
		DeadlinePort.fromAbi(ports.deadlines),
		Drivers.fromAbi(ports.links),
		Ai.fromAbi(ports.ai)
	);
const identityLayer = (publicUrl: string, identity: HostPorts['identity']) =>
	Layer.effect(
		HostIdentity,
		Effect.gen(function* () {
			const db = yield* TenantDb,
				manifest = yield* Manifest;
			return yield* makeIdentityHost({
				...identity,
				db,
				now: Clock.currentTimeMillis.pipe(Effect.map((at) => new Date(at))),
				windows: new RateWindows(),
				keys: yield* loadKeys(db),
				publicUrl,
				...(signupOf(manifest) === undefined ? {} : { signup: signupOf(manifest) })
			});
		})
	);

const activate = async (ports: HostPorts, options: Signal): Promise<ActiveWorkspace> => {
	const artifact = await artifactOf(ports.release, options),
		db = database(ports.database);
	const at = await inspection.runPromise(
		readApplied(db).pipe(Effect.map((applied) => plan(applied, artifact.manifest))),
		options
	);
	if (at.from !== at.to)
		throw BoltError.make(
			'schemaMismatch',
			'admission',
			`the environment's database is at schema ${at.from ?? '(none)'}, its release expects ${at.to}`
		);
	const transportLayer = Layer.unwrap(
		Effect.gen(function* () {
			const runNative = yield* FiberSet.makeRuntimePromise();
			const run = <A, E>(
				effect: Effect.Effect<A, E>,
				options?: { readonly signal?: AbortSignal | undefined }
			) => runNative(Effect.result(effect), options).then(Result.getOrThrow);
			const promiseDb: HostTenantDb = {
				read: (statements, signal) =>
					run(db.read(statements), signal === undefined ? undefined : { signal }),
				write: (statement, lock, signal) =>
					run(db.write(statement, lock), signal === undefined ? undefined : { signal }),
				transaction: (body, lock) =>
					run(
						db.transaction(
							Effect.gen(function* () {
								const tx = yield* TenantTx;
								return yield* hosted(() =>
									body({ query: (statement) => run(tx.query(statement)) })
								);
							}),
							lock
						)
					)
			};
			return Transport.fromAbi({
				Mail: ports.identity.mail,
				Sms: ports.identity.sms,
				...(ports.push === undefined ? {} : { Push: ports.push(promiseDb) })
			});
		})
	);
	const workspace = await inspection
		.runPromise(Effect.result(workspaceFiles(ports.release.dir)), options)
		.then(Result.getOrThrow);
	const capacity = (acquire: NonNullable<HostPorts['compute']>, message: string) =>
		Effect.acquireRelease(
			Effect.interruptible(
				Effect.tryPromise({
					try: (signal) => acquire({ signal }),
					catch: (error) => BoltError.make('upstream', 'admission', message, error)
				})
			),
			(release) => hosted(release).pipe(Effect.tapCause(Effect.logError), Effect.orDie)
		).pipe(Effect.asVoid);
	const host = Layer.mergeAll(
		Layer.succeed(TenantDb, db),
		activation(ports, artifact),
		portLayers(ports),
		transportLayer,
		Layer.succeed(AgentHost, { ...ports.agent, ...(workspace === undefined ? {} : { workspace }) }),
		Layer.succeed(GuestConfig, {
			...(ports.cpu === undefined ? {} : { cpu: ports.cpu }),
			...(ports.compute === undefined
				? {}
				: { compute: capacity(ports.compute, 'native CPU capacity was refused') }),
			...(ports.warmPreparation === undefined
				? {}
				: {
						warmPreparation: capacity(
							ports.warmPreparation,
							'background preparation capacity was refused'
						)
					})
		})
	);
	const engine = EngineLive(artifact.manifest).pipe(Layer.provideMerge(host));
	const shell = ShellRoutes.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				identityLayer(ports.publicUrl, ports.identity),
				Layer.succeed(ShellConfig, {
					...ports.shell,
					publicUrl: ports.publicUrl,
					secure: ports.publicUrl.startsWith('https:')
				}),
				Turnstile.unavailable,
				RateLimits.layer
			).pipe(Layer.provideMerge(engine))
		)
	);
	const runtime = ManagedRuntime.make(
		Layer.merge(BoltHostLive, publicPages(artifact)).pipe(
			Layer.provideMerge(shell),
			Layer.provideMerge(NodeServices.layer)
		)
	);
	const ready = await runtime
		.context()
		.then(Result.succeed, (error: unknown) => Result.fail(error));
	if (Result.isFailure(ready)) {
		await runtime.dispose();
		throw ready.failure;
	}
	const run = <A, E, R extends ManagedRuntime.ManagedRuntime.Services<typeof runtime>>(
		effect: Effect.Effect<A, E, R>,
		signal?: AbortSignal
	) =>
		guard(() =>
			runtime
				.runPromise(Effect.result(effect), signal === undefined ? undefined : { signal })
				.then(Result.getOrThrow)
		);

	let open = true;
	const incoming = (request: Request, address: string) =>
		HttpServerRequest.fromWeb(request).modify({ remoteAddress: Option.some(address) });
	/** One request's answer in web form; a closed generation refuses it before it runs. */
	const respond = <E, R extends ManagedRuntime.ManagedRuntime.Services<typeof runtime>>(
		response: Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>, E, R>,
		signal: AbortSignal
	) =>
		!open
			? guard(() =>
					Promise.reject(
						BoltError.make('interrupted', 'admission', 'The workspace generation is closed.')
					)
				)
			: run(
					Effect.map(response, (answer) =>
						Option.isNone(answer) ? null : HttpServerResponse.toWeb(answer.value)
					),
					signal
				);
	const served: ActiveWorkspace = {
		handle: (request, { address }) =>
			respond(
				Effect.flatMap(BoltHost, (host) => host.handle(incoming(request, address))),
				request.signal
			),
		render: (request, { address, signal }) =>
			respond(
				Effect.flatMap(PublicPages, (pages) => pages.render(incoming(request, address))),
				signal
			),
		wake: ({ signal }) =>
			run(
				Effect.flatMap(Runs, (runs) => runs.tick),
				signal
			),
		close: () => {
			open = false;
			return guard(() => runtime.dispose());
		},
		identity: {
			authority: (request, { signal }) =>
				run(authorityOf(HttpServerRequest.fromWeb(request)), signal),
			mint: (user, { signal }) =>
				run(
					Effect.flatMap(HostIdentity, (identity) => mint(identity, user)).pipe(
						Effect.catchTag('IdentityRefusal', () => Effect.succeed(null))
					),
					signal
				)
		}
	};
	activeRuns.set(served, (effect) => run(effect));
	return served;
};

const branch = async (ports: BranchPorts, options: Signal): Promise<WorkspaceBranch> => {
	const artifact = await artifactOf(ports.release, options),
		m = artifact.manifest,
		db = database(ports.database);
	const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>, signal: AbortSignal) =>
		guard(() => inspection.runPromise(Effect.result(effect), { signal }).then(Result.getOrThrow));
	return {
		schema: {
			migrate: ({ signal, accept }) =>
				run(
					readApplied(db).pipe(
						Effect.flatMap((applied) =>
							applyPlan(db, plan(applied, m), accept === undefined ? {} : { accept })
						)
					),
					signal
				)
		},
		packs: {
			load: (dir, { signal, at, files }) =>
				run(
					readPack(dir).pipe(
						Effect.flatMap((pack) =>
							files === undefined
								? loadPack(db, m, pack, at)
								: Effect.flatMap(Files, (store) => loadPackWithAssets(db, m, pack, store, at)).pipe(
										Effect.provide(Files.fromAbi(files))
									)
						)
					),
					signal
				)
		},
		identity: {
			founder: (address, { signal, at }) =>
				run(
					Effect.gen(function* (): Effect.fn.Return<FounderAnswer, EngineError, Crypto.Crypto> {
						const identity = yield* makeIdentityHost({
							db,
							now: Effect.succeed(new Date(at)),
							windows: new RateWindows(),
							keys: yield* loadKeys(db),
							publicUrl: 'http://localhost'
						});
						return yield* founderBootstrap(identity, address).pipe(
							Effect.map((session): FounderAnswer => ({ _tag: 'Founded', user: session.user })),
							Effect.catchTag('IdentityRefusal', (error) =>
								Effect.succeed({
									_tag: 'FounderRefused',
									code: error.code,
									message: error.message
								} satisfies FounderAnswer)
							)
						);
					}),
					signal
				)
		},
		integrations: {
			unpairSessions: ({ signal }) =>
				run(
					Effect.gen(function* () {
						const requests = Object.entries(m.integrations)
							.filter(
								([, integration]) =>
									integration.driver === 'http' || integration.driver === 'sqlserver'
							)
							.map(([name]) => name);
						yield* db.write({
							text: `WITH requests AS (SELECT jsonb_array_elements_text($1::jsonb) AS name), gone AS (DELETE FROM bolt_credential c USING sys_integration i WHERE c.instance = i.id AND i.integration NOT IN (SELECT name FROM requests)) UPDATE sys_integration SET epoch = NULL, status = '{"state":"unpaired","account":null}'::jsonb WHERE integration NOT IN (SELECT name FROM requests)`,
							params: [JSON.stringify(requests)]
						});
					}),
					signal
				)
		}
	};
};

const links = async (host: LinkHost, options: Signal): Promise<WorkspaceLinks> => {
	const artifact = await artifactOf(host.release, options),
		db = database(host.database);
	const secretsLayer = Secrets.layer(
		declaredSecrets(artifact.manifest),
		host.secretsKey === undefined ? Option.none() : Option.some(Redacted.make(host.secretsKey))
	).pipe(Layer.provideMerge(Layer.succeed(TenantDb, db)));
	const managerLayer = Layer.effect(
		LinkManagerService,
		Effect.gen(function* () {
			const secretService = yield* Secrets;
			const sealed = yield* credentials(db, secretService);
			const secrets = Object.fromEntries(
				(yield* Effect.forEach(declaredSecrets(artifact.manifest), (name) =>
					Config.option(Config.string(name)).pipe(
						Effect.provideService(ConfigProvider.ConfigProvider, secretService.config),
						Effect.map((value) => (Option.isSome(value) ? [[name, value.value] as const] : []))
					)
				)).flat()
			);
			const runPort = yield* FiberSet.makeRuntimePromise();
			const port: HostCredentials = {
				open: (instance) =>
					guard(() => runPort(Effect.result(sealed.open(instance))).then(Result.getOrThrow)),
				read: (instance) =>
					guard(() => runPort(Effect.result(sealed.read(instance))).then(Result.getOrThrow)),
				write: (instance, epoch, changes, rotate) =>
					guard(() =>
						runPort(Effect.result(sealed.write(instance, epoch, changes, rotate))).then(
							Result.getOrThrow
						)
					)
			};
			const wrapped = host.credentials?.(port);
			const through =
				wrapped === undefined
					? sealed
					: {
							open: (instance: string) =>
								hosted(() => wrapped.open(instance)).pipe(
									Effect.map((value) => ({
										...value,
										row: { ...value.row, import_start: value.row.import_start ?? null }
									}))
								),
							read: (instance: string) =>
								hosted(() => wrapped.read(instance)).pipe(
									Effect.map((value) => ({
										...value,
										row: { ...value.row, import_start: value.row.import_start ?? null }
									}))
								),
							write: (
								instance: string,
								epoch: string | null,
								changes: ReadonlyMap<string, Json | null>,
								rotate?: boolean
							) =>
								hosted(() => wrapped.write(instance, epoch, changes, rotate)).pipe(
									Effect.mapError((error) =>
										error._tag === 'BoltError' && error.code === 'fenced'
											? new Fenced({ instance, message: error.message })
											: error
									)
								)
						};
			return yield* integrationLinks({
				providers: host.providers,
				credentials: through,
				publicUrl: host.publicUrl,
				secrets,
				oauth: host.oauth,
				...(host.fetch === undefined ? {} : { fetch: host.fetch }),
				...(host.log === undefined ? {} : { log: host.log }),
				enter: (effect) =>
					hosted(() =>
						host.enter((workspace) => {
							const run = activeRuns.get(workspace);
							if (run === undefined)
								return Promise.reject(
									BoltError.make(
										'unavailable',
										'admission',
										'The workspace belongs to another Bolt release.'
									)
								);
							return run(
								Effect.gen(function* () {
									const conversations = yield* Conversations,
										feeds = yield* Feeds;
									const admit = <A, E>(guest: Effect.Effect<A, E, EngineServices>) =>
										hosted(() =>
											host.admit((current) => {
												const entry = activeRuns.get(current);
												return entry === undefined
													? Promise.reject(
															BoltError.make(
																'unavailable',
																'admission',
																'The current generation is unavailable.'
															)
														)
													: entry(guest);
											})
										);
									return yield* effect.pipe(
										Effect.provideService(Conversations, {
											...conversations,
											webhook: (instance, request) =>
												admit(conversations.webhook(instance, request))
										}),
										Effect.provideService(Feeds, {
											...feeds,
											test: (instance) => admit(feeds.test(instance))
										})
									);
								})
							);
						})
					)
			});
		})
	).pipe(Layer.provideMerge(secretsLayer));
	const runtime = ManagedRuntime.make(managerLayer.pipe(Layer.provideMerge(NodeServices.layer)));
	const ready = await runtime
		.context()
		.then(Result.succeed, (error: unknown) => Result.fail(error));
	if (Result.isFailure(ready)) {
		await runtime.dispose();
		throw ready.failure;
	}
	const requestRun = Effect.runPromiseWith(Result.getOrThrow(ready));
	const run = <A, E>(effect: Effect.Effect<A, E>, signal?: AbortSignal) =>
		guard(() =>
			runtime
				.runPromise(Effect.result(effect), signal === undefined ? undefined : { signal })
				.then(Result.getOrThrow)
		);
	const manager = await runtime.runPromise(LinkManagerService),
		sealed = await runtime.runPromise(Effect.flatMap(Secrets, (codec) => credentials(db, codec)));
	const own: HostCredentials = {
		open: (instance) => run(sealed.open(instance)),
		read: (instance) => run(sealed.read(instance)),
		write: (instance, epoch, changes, rotate) => run(sealed.write(instance, epoch, changes, rotate))
	};
	return {
		credentials: own,
		port: {
			send: (instance, message, signal, attachments) =>
				runtime
					.runPromise(
						Effect.result(
							manager.port.send(
								instance,
								message,
								attachments?.map(({ url, ...attachment }) => ({
									...attachment,
									...(url === undefined
										? {}
										: { url: (expiry: number) => Port.attempt('files.url', () => url(expiry)) })
								}))
							)
						),
						{ signal }
					)
					.then(Result.getOrThrow),
			typing: (instance, to, signal) =>
				runtime
					.runPromise(Effect.result(manager.port.typing(instance, to)), { signal })
					.then(Result.getOrThrow),
			request: (instance, operation, signal) =>
				requestRun(Effect.result(manager.port.request(instance, operation)), { signal }).then(
					Result.getOrThrow
				),
			read: (instance, feed, partition, cursor, signal) =>
				runtime
					.runPromise(Effect.result(manager.port.read(instance, feed, partition, cursor)), {
						signal
					})
					.then(Result.getOrThrow),
			changed: (instance) => {
				runtime.runFork(
					manager.port.changed(instance).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
				);
			}
		},
		resume: ({ signal }) => run(manager.resume, signal),
		close: () => guard(() => runtime.dispose()),
		hook: (request) =>
			run(
				Effect.gen(function* () {
					const incoming = new URL(request.url),
						base = new URL(host.publicUrl).pathname.replace(/\/+$/, '');
					const path =
						base !== '' && incoming.pathname.startsWith(base + '/')
							? incoming.pathname.slice(base.length)
							: incoming.pathname;
					if (path === OAUTH_CALLBACK) return yield* manager.callback(request);
					if (!path.startsWith(HOOKS)) return null;
					const instance = yield* Effect.try({
						try: () => decodeURIComponent(path.slice(HOOKS.length).split('/')[0] ?? ''),
						catch: () => BoltError.make('invalid', 'decode', 'Malformed integration path.')
					});
					return yield* manager.webhook(instance, request);
				}),
				request.signal
			),
		admin: (request, authority) =>
			run(
				integrationRoutes(HttpServerRequest.fromWeb(request)).pipe(
					Effect.provideService(IntegrationManager, Option.some(manager)),
					Effect.provideService(SessionAuthority, {
						of: () => Effect.succeed(Option.some(authority))
					}),
					Effect.map((answer) =>
						Option.isNone(answer) ? null : HttpServerResponse.toWeb(answer.value)
					)
				),
				request.signal
			)
	};
};
class LinkManagerService extends Context.Service<
	LinkManagerService,
	import('../engine/integrations/links.ts').LinkManager
>()('bolt/HostApiLinks') {}

export const HOST_API: HostApi = {
	guestExecution: 'source',
	version: HOST_API_VERSION,
	contract: CONTRACT,
	cookies: { session: COOKIES.session, preview: COOKIES.preview },
	cookieSite,
	needsGuest: (request) =>
		guard(() =>
			inspection.runPromise(
				needsGuest(HttpServerRequest.fromWeb(request.clone())).pipe(
					Effect.catch(() => Effect.succeed(true))
				),
				{ signal: request.signal }
			)
		),
	verify: (release, options) =>
		guard(async () => {
			await artifactOf(release, options);
		}),
	framePolicy: (release, path, options) =>
		guard(async () => framePolicy((await artifactOf(release, options)).manifest, path)),
	authority: (release, holder, key, options) =>
		guard(async () =>
			new Authorities((await artifactOf(release, options)).manifest, release.id).compile(
				holder,
				key
			)
		),
	schema: {
		slice: (release, options) =>
			guard(async () => schemaSlice((await artifactOf(release, options)).manifest)),
		destructive: (applied, release, options) =>
			guard(async () =>
				plan(applied, (await artifactOf(release, options)).manifest)
					.steps.filter((step) => step.class === 'destructive')
					.map((step) => step.id)
			)
	},
	activate: (ports, options) => guard(() => activate(ports, options)),
	branch: (ports, options) => guard(() => branch(ports, options)),
	links: (host, options) => guard(() => links(host, options))
};
