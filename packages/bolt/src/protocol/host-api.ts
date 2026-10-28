// HOST_API (D10a), `@norbital-ai/bolt/host-api`: the one surface between a host on another module graph and this release.
// A host loads each workspace's pinned Bolt from that release's own pnpm graph, whose `effect` is another copy: an Effect,
// Layer or service key of one copy is not one of the other. So the contract is plain: Promise + AbortSignal +
// Schema-encoded JSON, failures included. `Request`, `Response`, `AbortSignal` and `Uint8Array` are the realm's own and
// cross as they are; a port is a record of Promise functions. The engine's Node dependencies are ports too (the release's
// files, the database, keys, guest isolates, http, images, mcp), so this module runs unchanged inside a cell. Same-graph
// hosts (bolt-server, `bolt dev`, the kit) compose Bolt's layers directly; `host-api.conformance.integration.test.ts` runs
// one slice through both entries.
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
	Logger,
	ManagedRuntime,
	Option,
	PlatformError,
	References,
	Result,
	Schema,
	type FileSystem,
	type Path
} from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import type { Json } from '../decl/values.ts';
import type { Holder } from '../engine/access/authority.ts';
import { Authorities } from '../engine/identity/actor.ts';
import { RateWindows } from '../engine/access/rate.ts';
import {
	captureIdentity,
	directory,
	markAdmitted,
	restoreIdentity,
	type DirectoryPerson,
	type DirectoryMember,
	type AdministeredMember
} from '../engine/identity/maintenance.ts';
import {
	founderBootstrap,
	loadKeys,
	makeIdentityHost,
	mint,
	signupOf,
	type IdentityHost
} from '../engine/identity/session.ts';
import { Conflict, DbError, Fenced, Interrupted, type EngineError } from '../engine/errors.ts';
import { BoltError, CODES, PHASES, storeSync } from './errors.ts';
import type {
	ArtifactPort,
	Authority,
	BundlerPort,
	CronEntry,
	CronFired,
	HostPorts as EnginePorts,
	GuestIsolatesPort,
	HttpPort,
	ImagesPort,
	KeysPort,
	LinksPort,
	Lock,
	McpPort,
	DocsPort,
	Rows,
	Sql,
	TransportPort
} from '../engine/contracts.ts';
import { TenantDb, type DbBatch, type RawDb, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { auditFromAbi } from '../engine/audit.ts';
import type { AuditPort } from './audit.ts';
import { copiedBatch, dbError } from '../engine/db/wire.ts';
import { sha1 } from '../engine/crypto.ts';
import { sha256 } from '@norbital-ai/store';
import { EngineLive, type EngineServices, type EngineHost } from '../engine/host.ts';
import { Activation, Manifest, Runs } from '../engine/services.ts';
import {
	Ai,
	ArtifactFiles,
	Bundler,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	GuestIsolates,
	Http,
	Images,
	Docs,
	Keys,
	Logs,
	logsFromAbi,
	Mcp,
	Metering,
	Speech,
	Transport,
	WebRead,
	Browser
} from '../engine/ports.ts';
import { declaredSecrets } from '../engine/manifest.ts';
import { Secrets } from '../engine/secrets.ts';
import { AgentHost, type AgentConfig } from '../engine/agent/index.ts';
import { JournalEntry, RunJournal, type JournalPort } from '../engine/runs/journal.ts';
export type { JournalEntry, JournalPort } from '../engine/runs/journal.ts';
import { withBrowser } from '../engine/agent/browser.ts';
import {
	HOOKS,
	OAUTH_CALLBACK,
	integrationLinks,
	type LinkAdmission
} from '../engine/integrations/links.ts';
import { credentials } from '../engine/integrations/credentials.ts';
import type { OAuthClient, OAuthVendor, Provider } from '../engine/integrations/driver.ts';
import type { SchemaSlice } from '../engine/schema/plan.ts';
import { destructiveSteps, fingerprint, readApplied, schemaSlice } from '../engine/schema/plan.ts';
import { applyMigrations } from '../engine/schema/migrations.ts';
import type { MigrationImpact } from './migration-impact.ts';
import { packLoader, readPackSource, type PackStep } from '../engine/write/pack.ts';
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
	packAssetLoader,
	readArtifact,
	skillFiles,
	workspaceFiles,
	CONTRACT,
	type Artifact
} from '../engine/artifact/read.ts';
import { needsGuest, RateLimits, SessionAuthority } from './http.ts';
import { BoltHost, BoltHostLive } from './host.ts';
import { PublicPages, publicPages } from './pages.ts';
export { renderMode } from './pages.ts';
export { MigrationImpact, impactLines } from './migration-impact.ts';
import { IntegrationManager, integrationRoutes } from './integrations.ts';

/** Bumped on any change a host on an older copy could misread; the host refuses a release whose `version` differs. */
export const HOST_API_VERSION = 13;

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
/** A built workspace: `bolt build`'s release, with source, format and digests verified by this release. */
export type Release = {
	/** The host's release id (the artifact digest it records): authorities are compiled per release (rule 37). */
	readonly id: string;
	/** The release's files (`artifact.json`, `client/…`) and its seed packs (`../seed/<pack>/…`), read-only. */
	readonly artifact: ArtifactPort;
};
/**
 * The environment's database (D10a): Promise + AbortSignal; failures are `DbError`s (or what a driver threw, read as one).
 * The host owns the driver and its lifetime; rows are the adapters' JSON (`engine/db/wire.ts`).
 */
export type { DbBatch } from '../engine/db/tenant-db.ts';
/** The host retains this SQL-only lease until settlement; no application callback crosses HOST_API. */
export type HostDbSession = {
	readonly db: Omit<HostTenantDb, 'session'>;
	commit(signal?: AbortSignal): Promise<void>;
	rollback(signal?: AbortSignal): Promise<void>;
};
export type HostTenantDb = {
	read(statements: readonly Sql[], signal?: AbortSignal): Promise<readonly Rows[]>;
	write(statement: Sql, lock?: Lock, signal?: AbortSignal): Promise<Rows>;
	transaction(batch: DbBatch, signal?: AbortSignal): Promise<readonly Rows[]>;
	session(signal?: AbortSignal): Promise<HostDbSession>;
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
export type AgentPorts = Pick<AgentConfig, 'draft' | 'hostTools' | 'skills' | 'documentText'>;
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
	| 'browser'
	| 'links'
	| 'metering'
	| 'logs'
	| 'membership'
	| 'audit'
> & {
	/** Rule 61: this environment's epoch (a fork's rows are never sent). */
	readonly epoch?: string;
	/** `<tenant>/<environment>`: the deadlines scope and the log key. */
	readonly scope: string;
	readonly release: Release;
	readonly database: HostTenantDb;
	/** The workspace's public URL with its path prefix (`https://host/acme`), no trailing slash. */
	readonly publicUrl: string;
	/** Rule 70: the seed pack's `start` runs, queued once on the environment's first admission. */
	readonly start?: readonly string[];
	/** Guest isolates, made, metered and ended by the host: their CPU is the host's to read and bound. */
	readonly guestIsolates: GuestIsolatesPort;
	/** §5.11.4: sealing under the tenant's secrets key, which stays the host's; absent, no declared secret has a value. */
	readonly keys?: KeysPort;
	/** Outbound HTTP under the host's public-network policy. */
	readonly http?: HttpPort;
	/** The runs' journals in the host's control store; absent, runs journal in the generation's memory. */
	readonly journal?: JournalPort;
	/** The confined bundler for the agent's file runs; without one, `run_js` runs inline code only. */
	readonly bundler?: BundlerPort;
	readonly images?: ImagesPort;
	readonly mcp?: McpPort;
	/** This release's API reference files for the agent's `docs` tool. */
	readonly docs?: DocsPort;
	/** Web push for inbox notices, over the environment's database (a gone subscription is deleted there). */
	readonly push?: (db: HostTenantDb) => TransportPort;
	readonly identity: Pick<IdentityHost, 'mail' | 'sms' | 'phone' | 'devSink'>;
	readonly shell: ShellPorts;
	readonly agent: AgentPorts;
};
/** A branch the lifecycle prepares outside any serving generation (provision, reset, probe, restore). */
export type BranchPorts = {
	readonly release: Release;
	readonly database: HostTenantDb;
	/** The environment's durable host store, required when founder bootstrap mutates identity. */
	readonly audit?: AuditPort;
};
/** An environment's integration links (§4.5): they outlive idle generations and re-enter the current one. */
export type LinkHost = {
	readonly release: Release;
	readonly database: HostTenantDb;
	/** As `HostPorts.keys`: the sealed credentials open through it. */
	readonly keys?: KeysPort;
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
	/** The providers' network: a cell has no `fetch` of its own. */
	readonly fetch: typeof fetch;
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
	/** Every cron the manifest declares; the host's clock computes their slots. */
	crons(): Promise<readonly CronEntry[]>;
	/** Runs cron `id` for `slot` (an ISO minute), once per `(id, slot)`; `ran: false` for a repeat or a run that wrote nothing. */
	fire(id: string, slot: string, options: Signal): Promise<CronFired>;
	/** Rule 71a: interrupts every guest invocation and in-flight crossing of this generation; the host then ends its pool. */
	close(): Promise<void>;
	readonly identity: {
		/** The caller's compiled authority from the request's session, or `null`. */
		authority(request: Request, options: Signal): Promise<Authority | null>;
		/** `session.mint` for an active member; `null` for none. `agent`: minted for the agent's browser (`Authority.agent`). */
		mint(
			user: string,
			options: Signal & { readonly agent?: NonNullable<Authority['agent']> }
		): Promise<MintedSession | null>;
	};
};
export type WorkspaceBranch = {
	/** Persist the engine's admission marker before a cloned branch can serve work. */
	admitted(options: Signal): Promise<void>;
	readonly schema: {
		/**
		 * Engine tables, then the release's schema plan (rule 69; destructive steps only when accepted). Answers what it
		 * did (v13): each pending step's rows and the whole duration, measured on this branch.
		 */
		migrate(
			options: Signal & { readonly accept?: true | readonly string[] }
		): Promise<MigrationImpact>;
	};
	readonly packs: {
		/** Rule 70: a seed pack by name (`base`, `sample`), its assets into `files` when given, ready to load in steps. */
		load(
			pack: string,
			options: Signal & { readonly at: string; readonly files?: EnginePorts['files'] }
		): Promise<PackLoad>;
	};
	readonly identity: {
		founder(address: string, options: Signal & { readonly at: string }): Promise<FounderAnswer>;
		capture(options: Signal): Promise<string>;
		restore(snapshot: string, options: Signal): Promise<void>;
	};
	readonly directory: {
		memberOf(person: DirectoryPerson, options: Signal): Promise<string | null>;
		personOf(user: string, options: Signal): Promise<DirectoryPerson | null>;
		members(options: Signal): Promise<readonly DirectoryMember[]>;
		administered(email: string, options: Signal): Promise<readonly AdministeredMember[] | null>;
	};
	readonly integrations: {
		/** FINAL §4.5: a restored branch's session instances lose their credentials and read `unpaired`. */
		unpairSessions(options: Signal): Promise<void>;
	};
};
/**
 * A pack load in bounded steps (compute model §3, "Limits and liveness"): the host enters `step` once per unit of work
 * until it answers other than `more`; `hadRows` when the branch had rows and nothing changed. Each step commits on its
 * own, so a failed load leaves the steps before it: load into a branch the host drops on failure.
 */
export type PackLoad = {
	step(options: Signal): Promise<PackStep>;
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
/** The host executes SQL requests; application callbacks remain inside the engine's bounded guest controller. */
const databaseMethods = (port: Omit<HostTenantDb, 'session'>): Omit<RawDb, 'session'> => {
	const attempt = <A>(work: (signal: AbortSignal) => Promise<A>) =>
		Effect.tryPromise({ try: work, catch: dbError });
	return {
		read: (statements) =>
			Effect.try({ try: () => copiedBatch({ statements }).statements, catch: dbError }).pipe(
				Effect.flatMap((prepared) => attempt((signal) => port.read(prepared, signal)))
			),
		write: (statement, lock) =>
			Effect.try({
				try: () =>
					copiedBatch({ statements: [statement], ...(lock === undefined ? {} : { lock }) }),
				catch: dbError
			}).pipe(
				Effect.flatMap((prepared) =>
					attempt((signal) => port.write(prepared.statements[0]!, prepared.lock, signal))
				)
			),
		transaction: (batch) =>
			Effect.try({ try: () => copiedBatch(batch), catch: dbError }).pipe(
				Effect.flatMap((prepared) => attempt((signal) => port.transaction(prepared, signal)))
			)
	};
};
const database = (port: HostTenantDb): TenantDbShape =>
	TenantDb.typed({
		...databaseMethods(port),
		session: () =>
			Effect.gen(function* () {
				const session = yield* Effect.acquireRelease(
					Effect.tryPromise({ try: (signal) => port.session(signal), catch: dbError }),
					(lease) =>
						Effect.tryPromise({ try: () => lease.rollback(), catch: dbError }).pipe(
							Effect.catch(() => Effect.void)
						)
				);
				return {
					db: databaseMethods(session.db),
					commit: Effect.tryPromise({ try: (signal) => session.commit(signal), catch: dbError }),
					rollback: Effect.tryPromise({ try: (signal) => session.rollback(signal), catch: dbError })
				};
			})
	});
/** This release's own diagnostics, in every runtime: one JSON event per line on stdout, for the host's collector. */
const logging = Logger.layer([Logger.consoleJson]);
/** Random bytes from the runtime's `crypto`; the digests are this release's own (a cell has no `crypto.subtle`). */
const cryptoLayer = Layer.succeed(
	Crypto.Crypto,
	Crypto.make({
		randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
		digest: (algorithm, data) =>
			algorithm === 'SHA-1'
				? Effect.succeed(sha1(data))
				: algorithm === 'SHA-256'
					? Effect.succeed(sha256(data))
					: Effect.fail(
							PlatformError.badArgument({
								module: 'Crypto',
								method: 'digest',
								description: `${algorithm} is not supported`
							})
						)
	})
);
/** The release's files root: artifact paths are relative to it. */
const ROOT = '';
/** One call's own runtime over the release's files; nothing outlives the call. */
const inRelease = <A, E>(
	release: Release,
	effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
	signal: AbortSignal
) =>
	Effect.runPromise(
		Effect.result(
			effect.pipe(
				Effect.provide(
					Layer.mergeAll(ArtifactFiles.fileSystem(release.artifact), cryptoLayer, logging)
				)
			)
		),
		{ signal }
	).then(Result.getOrThrow);
/** The kernel admitted the release (every digest) before handing it over: here only what runs is checked again. */
const artifactOf = (release: Release, options: Signal) =>
	inRelease(release, readArtifact(ROOT, [CONTRACT], 'executed'), options.signal);

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
		start: ports.start ?? []
	});
/** Host-provided records cross only this explicit Promise ABI adapter. */
const portLayers = (ports: HostPorts) =>
	Layer.mergeAll(
		auditFromAbi(ports.audit).pipe(Layer.provide(cryptoLayer)),
		Files.fromAbi(ports.files),
		Convert.fromAbi(ports.convert),
		Speech.fromAbi(ports.speech),
		WebRead.fromAbi(ports.web),
		Browser.fromAbi(ports.browser),
		Geo.fromAbi(ports.geocoder),
		Metering.fromAbi(ports.metering),
		DeadlinePort.fromAbi(ports.deadlines),
		Drivers.fromAbi(ports.links),
		Ai.fromAbi(ports.ai),
		GuestIsolates.fromAbi(ports.guestIsolates),
		Keys.fromAbi(ports.keys),
		Http.fromAbi(ports.http),
		Images.fromAbi(ports.images),
		Docs.fromAbi(ports.docs),
		Mcp.fromAbi(ports.mcp),
		...(ports.bundler === undefined ? [] : [Bundler.fromAbi(ports.bundler)])
	);
/** The host's run journals: a rejection the host encoded keeps its code (`journalFull`); a read is decoded once. */
const journalLayer = (port: JournalPort) => {
	const call = <A>(work: (signal: AbortSignal) => Promise<A>) =>
		Effect.tryPromise({
			try: work,
			catch: (error) =>
				isFailure(error)
					? BoltError.make(isCode(error.code) ? error.code : 'internal', error.phase, error.message)
					: BoltError.make('upstream', 'facility', `the run journal failed: ${String(error)}`)
		});
	const entries = Schema.decodeUnknownEffect(Schema.Array(JournalEntry));
	return Layer.succeed(RunJournal, {
		read: (run) =>
			call((signal) => port.read(run, signal)).pipe(
				Effect.flatMap((rows) =>
					entries(rows).pipe(
						Effect.mapError((error) =>
							BoltError.make('corrupt', 'facility', `the run journal answered: ${error.message}`)
						)
					)
				)
			),
		write: (run, entry) => call((signal) => port.write(run, entry, signal)),
		clear: (run) => call((signal) => port.clear(run, signal))
	});
};
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
	const at = await inRelease(
		ports.release,
		readApplied(db).pipe(
			Effect.map((applied) => ({
				from: applied === null ? null : fingerprint(applied),
				to: fingerprint(schemaSlice(artifact.manifest))
			}))
		),
		options.signal
	);
	if (at.from !== at.to)
		throw BoltError.make(
			'schemaMismatch',
			'admission',
			`the environment's database is at schema ${at.from ?? '(none)'}, its release expects ${at.to}`
		);
	const files = ArtifactFiles.fileSystem(ports.release.artifact);
	const host = Layer.mergeAll(
		Layer.succeed(TenantDb, db),
		activation(ports, artifact),
		portLayers(ports),
		Transport.fromAbi({
			Mail: ports.identity.mail,
			Sms: ports.identity.sms,
			...(ports.push === undefined ? {} : { Push: ports.push(ports.database) })
		}),
		...(ports.logs === undefined ? [] : [Layer.succeed(Logs, logsFromAbi(ports.logs))]),
		...(ports.journal === undefined ? [] : [journalLayer(ports.journal)]),
		Layer.effect(
			AgentHost,
			Effect.flatMap(Effect.all([workspaceFiles(ROOT), skillFiles(ROOT)]), ([workspace, skills]) =>
				withBrowser({
					...ports.agent,
					skillFiles: skills,
					...(workspace === undefined ? {} : { workspace })
				})
			)
		).pipe(Layer.provide(Layer.merge(Browser.fromAbi(ports.browser), files))),
		files,
		cryptoLayer
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
			Layer.provideMerge(logging),
			Layer.provideMerge(
				Layer.succeed(References.CurrentLogAnnotations, { workspace: ports.scope })
			)
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
		crons: () => run(Effect.flatMap(Runs, (runs) => runs.crons)),
		fire: (id, slot, { signal }) =>
			run(
				Effect.flatMap(Runs, (runs) => runs.fire(id, slot)),
				signal
			),
		close: () => {
			open = false;
			return guard(() => runtime.dispose());
		},
		identity: {
			authority: (request, { signal }) =>
				run(authorityOf(HttpServerRequest.fromWeb(request)), signal),
			mint: (user, { signal, agent }) =>
				run(
					Effect.flatMap(HostIdentity, (identity) => mint(identity, user, agent)).pipe(
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
	const run = <A, E>(
		effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
		signal: AbortSignal
	) => guard(() => inRelease(ports.release, effect, signal));
	const people = directory(db);
	return {
		admitted: ({ signal }) => run(markAdmitted(db), signal),
		schema: {
			migrate: ({ signal }) => run(applyMigrations(db, m, artifact.migrations), signal)
		},
		packs: {
			load: (pack, { signal, at, files }) =>
				run(
					readPackSource(`../seed/${pack}`).pipe(
						Effect.flatMap((pack) =>
							files === undefined
								? packLoader(db, m, pack, at)
								: Effect.flatMap(Files, (store) => packAssetLoader(db, m, pack, store, at)).pipe(
										Effect.provide(Files.fromAbi(files))
									)
						),
						// the loader's state stays in this cell between the host's entries
						Effect.map(({ step }): PackLoad => ({ step: (options) => run(step, options.signal) }))
					),
					signal
				)
		},
		identity: {
			capture: ({ signal }) => run(captureIdentity(db), signal),
			restore: (snapshot, { signal }) => run(restoreIdentity(db, m, snapshot), signal),
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
					}).pipe(Effect.provide(auditFromAbi(ports.audit))),
					signal
				)
		},
		directory: {
			memberOf: (person, { signal }) => run(people.memberOf(person), signal),
			personOf: (user, { signal }) => run(people.personOf(user), signal),
			members: ({ signal }) => run(people.members, signal),
			administered: (email, { signal }) => run(people.administered(email), signal)
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
	const secretsLayer = Secrets.layer(declaredSecrets(artifact.manifest)).pipe(
		Layer.provideMerge(Layer.merge(Layer.succeed(TenantDb, db), Keys.fromAbi(host.keys)))
	);
	const managerLayer = Layer.effect(
		LinkManagerService,
		Effect.gen(function* () {
			const secretService = yield* Secrets;
			const sealed = yield* credentials(db, secretService);
			const secrets = Object.fromEntries(
				(yield* Effect.forEach(declaredSecrets(artifact.manifest), (name) =>
					Config.option(Config.String(name)).pipe(
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
			/** `effect` on the scope's current generation, reached through `via`. */
			const on =
				(via: LinkHost['enter']) =>
				<A, E>(effect: Effect.Effect<A, E, LinkAdmission>) =>
					hosted(() =>
						via((workspace) => {
							const run = activeRuns.get(workspace);
							return run === undefined
								? Promise.reject(
										BoltError.make(
											'unavailable',
											'admission',
											'The workspace belongs to another Bolt release.'
										)
									)
								: run(effect);
						})
					);
			return yield* integrationLinks({
				providers: host.providers,
				credentials: through,
				publicUrl: host.publicUrl,
				secrets,
				oauth: host.oauth,
				fetch: host.fetch,
				...(host.log === undefined ? {} : { log: host.log }),
				enter: on(host.enter),
				admit: on(host.admit)
			});
		})
	).pipe(Layer.provideMerge(secretsLayer));
	const runtime = ManagedRuntime.make(
		managerLayer.pipe(Layer.provideMerge(cryptoLayer), Layer.provideMerge(logging))
	);
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
			typing: (instance, to, signal, on) =>
				runtime
					.runPromise(Effect.result(manager.port.typing(instance, to, on)), { signal })
					.then(Result.getOrThrow),
			request: (instance, operation, signal) =>
				requestRun(Effect.result(manager.port.request(instance, operation)), { signal }).then(
					Result.getOrThrow
				),
			read: (instance, sync, partition, cursor, signal) =>
				runtime
					.runPromise(Effect.result(manager.port.read(instance, sync, partition, cursor)), {
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
			Effect.runPromise(
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
				storeSync(destructiveSteps(applied, (await artifactOf(release, options)).manifest))
			)
	},
	activate: (ports, options) => guard(() => activate(ports, options)),
	branch: (ports, options) => guard(() => branch(ports, options)),
	links: (host, options) => guard(() => links(host, options))
};
