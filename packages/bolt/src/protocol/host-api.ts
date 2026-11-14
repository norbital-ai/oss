// HOST_API (D10a), `@norbital-ai/bolt/host-api`: this release's implementation of `@norbital-ai/host-api`'s `HostApi`,
// the one surface between a host on another module graph and this release.
// A host loads each workspace's pinned Bolt from that release's own install graph, whose `effect` is another copy: an Effect,
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
	References,
	Result,
	Schema,
	type FileSystem,
	type Path
} from 'effect';
import * as HttpServerRequest from 'effect/http/HttpServerRequest';
import * as HttpServerResponse from 'effect/http/HttpServerResponse';
import type { Json } from '../decl/values.ts';
import { RateWindows } from '../engine/access/rate.ts';
import { triggers_of } from '../engine/runs/queue.ts';
import { captureIdentity, restoreIdentity } from '../engine/identity/maintenance.ts';
import {
	founder_bootstrap,
	lazyKeys,
	load_keys,
	make_identity_host,
	mint,
	signup_of,
	type IdentityHost
} from '../engine/identity/session.ts';
import { Conflict, Interrupted, type EngineError } from '../engine/errors.ts';
import { BoltError, CODES, PHASES } from './errors.ts';
import type { Authority as EngineAuthority } from '../engine/contracts.ts';
import {
	type ActiveWorkspace,
	Authority,
	type BranchPorts,
	copiedBatch,
	db_error,
	DbError,
	Fenced,
	type FilesPort,
	type FounderAnswer,
	HOST_API_VERSION,
	type HostApi,
	type HostApiFailure,
	type HostCredentials,
	HostFailure,
	type HostPorts,
	type HostTenantDb,
	is_off,
	type LinkHost,
	MigrationCarry,
	OAUTH_CALLBACK,
	type PackLoad,
	Port,
	type Release,
	type ReleaseFacts,
	SchemaSlice,
	type WorkspaceBranch,
	type WorkspaceLinks
} from '@norbital-ai/host-api';
import { unmet } from '../facilities/needs.ts';
import { TenantDb, type TenantDbShape } from '../engine/db/tenant-db.ts';
import { audit_from_abi } from '../engine/audit.ts';
import { cryptoLayer, facility_layers } from './facility-layers.ts';
import { EngineLive, type EngineServices, type EngineHost } from '../engine/host.ts';
import { Activation, Agents, Automations, HostIdentity, Live, Manifest, Runs } from '../engine/services.ts';
import {
	ArtifactFiles,
	Bundler,
	Convert,
	DeadlinePort,
	Drivers,
	Files,
	Geo,
	GuestIsolates,
	Images,
	Docs,
	Keys,
	Mcp,
	Render,
	WebRead,
	Browser,
	RunUnits
} from '../engine/ports.ts';
import { declared_secrets } from '../engine/manifest.ts';
import { Secrets } from '../engine/secrets.ts';
import { AgentHost } from '../engine/agent/index.ts';
import { with_browser } from '../engine/agent/browser.ts';
import {
	HOOKS,
	integration_links,
	type LinkAdmission
} from '../engine/integrations/links.ts';
import { credentials, type Credentials } from '../engine/integrations/credentials.ts';
import { destructiveSteps, fingerprint, read_applied, schema_slice, SchemaSliceSchema } from '../engine/schema/plan.ts';
import { apply_migrations } from '../engine/schema/migrations.ts';
import { carry_migrations } from '../engine/schema/carry.ts';
import {
	decode_identity,
	IDENTITY,
	memory_source,
	packLoader,
	read_pack_source,
	type PackSource
} from '../engine/write/pack.ts';
import { decode_seed } from '../engine/write/seed.ts';
import { announce } from '../engine/notifications/notify.ts';
import { authority_of, ShellConfig, ShellRoutes } from '../shell/host.ts';
import { COOKIES, cookie_site, frame_policy, href } from '../shell/nav.ts';
import {
	pack_asset_loader,
	read_artifact,
	activation_requirements,
	skill_files,
	workspace_files,
	CONTRACT,
	type Artifact
} from '../engine/artifact/read.ts';
import { needs_guest, RateLimits, SessionAuthority } from './http.ts';
import { BoltHost, BoltHostLive } from './host.ts';
import { PublicPages, public_pages } from './pages.ts';
import { IntegrationManager, integration_routes } from './integrations.ts';

// ── failures (D10a) ──
const isPhase = Schema.is(Schema.Literals(PHASES));

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
		.catch((error: unknown) => Promise.reject(encode(error)));
type PromiseRunner<R> = <A, E>(effect: Effect.Effect<A, E, R>, options?: Effect.RunOptions) => Promise<A>;
/** Unwrap typed failures without changing their release-native identity. */
const effectPromise = <R>(runner: PromiseRunner<R>) =>
	<A, E>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal): Promise<A> =>
		runner(Effect.result(effect), signal === undefined ? undefined : { signal }).then(Result.getOrThrow);
/** Host-interpreted answers cross with the encoded failure contract. */
const encodedPromise = <R>(runner: PromiseRunner<R>) => {
	const run = effectPromise(runner);
	return <A, E>(effect: Effect.Effect<A, E, R>, signal?: AbortSignal): Promise<A> =>
		guard(() => run(effect, signal));
};
/** A host call without a runtime of its own: one run, failures encoded. */
const hostRun = encodedPromise<never>(Effect.runPromise);
/** The runtime's services; a failed or interrupted boot disposes it. */
const bootRuntime = <R, E>(runtime: ManagedRuntime.ManagedRuntime<R, E>) =>
	runtime.contextEffect.pipe(Effect.onError(() => runtime.disposeEffect));
const credentialPort = (sealed: Credentials, run: ReturnType<typeof encodedPromise<never>>): HostCredentials => ({
	open: (instance) => run(sealed.open(instance)),
	read: (instance) => run(sealed.read(instance)),
	write: (instance, epoch, changes, rotate) => run(sealed.write(instance, epoch, changes, rotate))
});
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
					? BoltError.make(
							isCode(error.code) ? error.code : 'internal',
							isPhase(error.phase) ? error.phase : 'facility',
							error.message
						)
					: BoltError.make('upstream', 'facility', String(error))
	});
/** The host executes SQL requests; application callbacks remain inside the engine's bounded guest controller. */
const database = (port: HostTenantDb): TenantDbShape => {
	const attempt = <A>(work: (signal: AbortSignal) => Promise<A>) =>
		Effect.tryPromise({ try: work, catch: db_error });
	return TenantDb.typed({
		read: (statements) =>
			Effect.try({ try: () => copiedBatch({ statements }).statements, catch: db_error }).pipe(
				Effect.flatMap((prepared) => attempt((signal) => port.read(prepared, signal)))
			),
		write: (statement, lock) =>
			Effect.try({
				try: () =>
					copiedBatch({ statements: [statement], ...(lock === undefined ? {} : { lock }) }),
				catch: db_error
			}).pipe(
				Effect.flatMap((prepared) => {
					const statement = prepared.statements[0];
					return statement === undefined
						? Effect.fail(DbError.make('08P01', 'A copied write contained no statement.'))
						: attempt((signal) => port.write(statement, prepared.lock, signal));
				})
			),
		transaction: (batch) =>
			Effect.try({ try: () => copiedBatch(batch), catch: db_error }).pipe(
				Effect.flatMap((prepared) => attempt((signal) => port.transaction(prepared, signal)))
			)
	});
};
/** This release's own diagnostics, in every runtime: one JSON event per line on stdout, for the host's collector. */
const logging = Logger.layer([Logger.consoleJson]);

/** The release's files root: artifact paths are relative to it. */
const ROOT = '';
/** One call's effect over the release's files; nothing outlives the call. */
const inRelease = <A, E>(
	release: Release,
	effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>
) =>
	effect.pipe(
		Effect.provide(Layer.mergeAll(ArtifactFiles.fileSystem(release.artifact), cryptoLayer, logging))
	);
const readRelease = (release: Release) =>
	inRelease(release, read_artifact(ROOT, [CONTRACT], 'executed'));
type ArtifactRead = Result.Result<Artifact, Effect.Error<ReturnType<typeof readRelease>>>;
/**
 * The kernel admitted the release (every digest) before handing it over: here only what runs is checked again, once per
 * release. A cell serves one release at a time, and every page load's static call reads it: concurrent reads of the
 * whole release (guest code, source map, asset digests) would exhaust the cell's memory. The shared read outlives any
 * one caller, so a caller's interruption leaves it running; a failed read is not kept.
 */
let held: { readonly id: string; readonly artifact: Promise<ArtifactRead> } | undefined;
const artifactOf = (release: Release) =>
	Effect.suspend(() => {
		if (held?.id !== release.id) {
			const artifact = Effect.runPromise(Effect.result(readRelease(release)));
			const entry = { id: release.id, artifact };
			held = entry;
			const forget = () => {
				if (held === entry) held = undefined;
			};
			artifact.then((read) => {
				if (Result.isFailure(read)) forget();
			}, forget);
		}
		const { artifact } = held;
		return Effect.promise(() => artifact).pipe(Effect.flatMap((read) => Effect.fromResult(read)));
	});

const activeRuns = new WeakMap<
	ActiveWorkspace,
	<A, E>(effect: Effect.Effect<A, E, EngineServices | EngineHost | SessionAuthority>) => Promise<A>
>();
/** A caller's compiled authority as a host reads it: the engine's own stays in the release. */
const hostAuthority = (authority: EngineAuthority | null) =>
	authority === null
		? Effect.succeed(null)
		: Schema.decodeUnknownEffect(Authority)(authority).pipe(
				Effect.mapError((cause) => BoltError.make('internal', 'decode', cause.message))
			);
const activation = (ports: HostPorts, artifact: Artifact) =>
	Layer.succeed(Activation, {
		scope: ports.scope,
		epoch: ports.epoch ?? '',
		release: ports.release.id,
		public_url: ports.public_url,
		guest: Option.some(artifact.guest),
		...(ports.overran === undefined ? {} : { overran: ports.overran })
	});
/** Host-provided records cross only this explicit Promise ABI adapter. */
const portLayers = ({ units, ...ports }: HostPorts) =>
	Layer.mergeAll(
		facility_layers(ports.facilities),
		GuestIsolates.fromAbi(ports.guests),
		Convert.fromAbi(ports.convert),
		Render.fromAbi(ports.render),
		WebRead.fromAbi(ports.web),
		Browser.fromAbi(ports.browser),
		Geo.fromAbi(ports.geocoder),
		DeadlinePort.fromAbi(ports.deadlines),
		Drivers.fromAbi(ports.links),
		Images.fromAbi(ports.images),
		Docs.fromAbi(ports.release.artifact),
		Mcp.fromAbi(ports.mcp),
		...(is_off(ports.bundler) ? [] : [Bundler.fromAbi(ports.bundler)]),
		units === undefined
			? Layer.empty
			: Layer.succeed(RunUnits, {
					next: () => Effect.tryPromise(() => units.next()).pipe(Effect.ignore)
				})
	);
const identityLayer = (
	public_url: string,
	identity: Pick<IdentityHost, 'mail' | 'sms' | 'phone' | 'dev_sink'>
) =>
	Layer.effect(
		HostIdentity,
		Effect.gen(function* () {
			const db = yield* TenantDb,
				manifest = yield* Manifest;
			return yield* make_identity_host({
				...identity,
				db,
				now: Clock.currentTimeMillis.pipe(Effect.map((at) => new Date(at))),
				windows: new RateWindows(),
				keys: lazyKeys(db),
				public_url,
				writes: triggers_of(manifest).writes,
				...(signup_of(manifest) === undefined ? {} : { signup: signup_of(manifest) })
			});
		})
	);

const activate = Effect.fn('bolt.hostApi.activate')(function* (ports: HostPorts) {
	const artifact = yield* artifactOf(ports.release),
		f = ports.facilities,
		db = database(f.storage.database);
	const missing = unmet(artifact.manifest.needs, f);
	if (missing.length > 0)
		return yield* Effect.fail(
			BoltError.make(
				'unavailable',
				'admission',
				`the bundle needs ${missing.join(', ')}, which this host leaves off`
			)
		);
	// checked before the first statement rather than at the start: a cold start makes no trip to the database
	const expected = fingerprint(schema_slice(artifact.manifest));
	db.owe(
		read_applied(db).pipe(
			Effect.flatMap((applied) => {
				const from = applied?.fingerprint ?? null;
				return from === expected
					? Effect.void
					: Effect.fail(
							BoltError.make(
								'schema_mismatch',
								'admission',
								`the environment's database is at schema ${from ?? '(none)'}, its release expects ${expected}`
							)
						);
			}),
			Effect.catchTag('BoltError', (error) => Effect.fail(DbError.make('XX000', error.message)))
		)
	);
	const files = ArtifactFiles.fileSystem(ports.release.artifact);
	const identity = identityLayer(ports.public_url, {
		mail: f.transactional.mail,
		dev_sink: f.transactional.fixed_codes,
		...(is_off(f.transactional.sms) ? {} : { sms: f.transactional.sms }),
		...(is_off(f.transactional.phone) ? {} : { phone: f.transactional.phone })
	}).pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(TenantDb, db),
				Layer.succeed(Manifest, artifact.manifest),
				audit_from_abi(f.logs.audit).pipe(Layer.provide(cryptoLayer)),
				cryptoLayer
			)
		)
	);
	const host = Layer.mergeAll(
		identity,
		Layer.succeed(TenantDb, db),
		activation(ports, artifact),
		portLayers(ports),
		Layer.effect(
			AgentHost,
			Effect.flatMap(Effect.all([workspace_files(ROOT), skill_files(ROOT)]), ([workspace, skills]) =>
				with_browser({
					...ports.agent,
					skill_files: skills,
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
				Layer.succeed(ShellConfig, {
					...ports.shell,
					client: artifact.artifact.hashes.client,
					public_url: ports.public_url,
					secure: ports.public_url.startsWith('https:')
				}),
				RateLimits.layer
			).pipe(Layer.provideMerge(engine))
		)
	);
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			BoltHostLive,
			public_pages(artifact),
			// "release changed": a closing generation tells its open pages; they reload onto the serving release
			Layer.effectDiscard(
				Effect.addFinalizer(() => Effect.flatMap(Live, (live) => live.close(ports.release.id)))
			)
		).pipe(
			Layer.provideMerge(shell),
			Layer.provideMerge(logging),
			Layer.provideMerge(
				Layer.succeed(References.CurrentLogAnnotations, { workspace: ports.scope })
			)
		)
	);
	yield* bootRuntime(runtime);
	const run = encodedPromise<ManagedRuntime.ManagedRuntime.Services<typeof runtime>>(runtime.runPromise);

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
	const events = ports.agent.events;
	const announced =
		events === undefined
			? Effect.void
			: Effect.gen(function* () {
					const since = new Date((yield* Clock.currentTimeMillis) - 86_400_000).toISOString();
					yield* announce(yield* Port.attempt('agent.events', () => events(since)));
				}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore);
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
		// a wake also delivers the last day's workspace events to the inbox, so a host announces one by waking
		wake: ({ signal }) =>
			run(Effect.flatMap(Runs, (runs) => runs.tick).pipe(Effect.andThen(announced)), signal),
		pulse: ({ signal }) => run(Effect.flatMap(Runs, (runs) => runs.pulse), signal),
		park: ({ signal, automations_ms }) =>
			run(
				Effect.all([Effect.flatMap(Runs, (runs) => runs.park), Effect.flatMap(Automations, (automations) => automations.park)], { concurrency: 'unbounded', discard: true }).pipe(
					Effect.timeoutOption(automations_ms),
					Effect.andThen(Effect.flatMap(Agents, (agents) => agents.park))
				),
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
				run(authority_of(HttpServerRequest.fromWeb(request)).pipe(Effect.flatMap(hostAuthority)), signal),
			mint: (user, { signal, agent }) =>
				run(
					Effect.flatMap(HostIdentity, (identity) => mint(identity, user, agent)).pipe(
						Effect.map(({ token, user, expiresAt }) => ({ token, user, expires_at: expiresAt })),
						Effect.catchTag('IdentityRefusal', () => Effect.succeed(null))
					),
					signal
				)
		}
	};
	activeRuns.set(served, (effect) => run(effect));
	return served;
});

const branch = Effect.fn('bolt.hostApi.branch')(function* (ports: BranchPorts) {
	const artifact = yield* artifactOf(ports.release),
		m = artifact.manifest,
		db = database(ports.database);
	const run = <A, E>(
		effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
		signal: AbortSignal
	) => hostRun(inRelease(ports.release, effect), signal);
	// the loader's state stays in this cell between the host's entries
	const loader = (at: string, files: FilesPort | undefined) => (pack: PackSource) =>
		(files === undefined
			? packLoader(db, m, pack, at)
			: Effect.flatMap(Files, (store) => pack_asset_loader(db, m, pack, store, at)).pipe(
					Effect.provide(Files.fromAbi(files))
				)
		).pipe(Effect.map(({ step }): PackLoad => ({ step: (options) => run(step, options.signal) })));
	const branched: WorkspaceBranch = {
		schema: {
			migrate: ({ signal }) => run(apply_migrations(db, m, artifact.migrations), signal)
		},
		packs: {
			load: (pack, { signal, at, files }) =>
				run(read_pack_source(`../seed/${pack}`).pipe(Effect.flatMap(loader(at, files))), signal),
			restore: (rows, { signal, at, start, assets, asset, files }) =>
				run(
					Effect.try({
						try: () => {
							decode_identity(m, rows);
							decode_seed(
								m,
								Object.fromEntries(
									Object.entries(rows).filter(([c]) => !IDENTITY.some((i) => i === c))
								)
							);
							return memory_source('private', rows, start, assets, (path) =>
								Effect.tryPromise({
									try: (signal) => asset(path, { signal }),
									catch: (cause) =>
										BoltError.make('seed_decode', 'decode', `seed asset ${path}: ${String(cause)}`)
								})
							);
						},
						catch: (cause) =>
							cause instanceof BoltError
								? cause
								: BoltError.make('seed_decode', 'decode', String(cause))
					}).pipe(Effect.flatMap(loader(at, files))),
					signal
				)
		},
		identity: {
			capture: ({ signal }) => run(captureIdentity(db), signal),
			restore: (snapshot, { signal }) => run(restoreIdentity(db, m, snapshot), signal),
			founder: (address, { signal, at }) => {
				const audit = ports.audit;
				if (audit === undefined)
					return guard(() =>
						Promise.reject(
							BoltError.make('unavailable', 'admission', 'founder bootstrap needs the audit store')
						)
					);
				return run(
					Effect.gen(function* (): Effect.fn.Return<FounderAnswer, EngineError, Crypto.Crypto> {
						const identity = yield* make_identity_host({
							db,
							now: Effect.succeed(new Date(at)),
							windows: new RateWindows(),
							keys: yield* load_keys(db),
							public_url: 'http://localhost'
						});
						return yield* founder_bootstrap(identity, address).pipe(
							Effect.map((session): FounderAnswer => ({ _tag: 'Founded', user: session.user })),
							Effect.catchTag('IdentityRefusal', (error) =>
								Effect.succeed({
									_tag: 'FounderRefused',
									code: error.code,
									message: error.message
								} satisfies FounderAnswer)
							)
						);
					}).pipe(Effect.provide(audit_from_abi(audit))),
					signal
				);
			}
		},
		integrations: {
			unpair_sessions: ({ signal }) =>
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
	return branched;
});

const links = Effect.fn('bolt.hostApi.links')(function* (host: LinkHost) {
	const artifact = yield* artifactOf(host.release),
		db = database(host.database);
	/** `effect` on the scope's current generation, reached through `via`. */
	const on =
		(via: LinkHost['enter']) =>
		<A, E>(effect: Effect.Effect<A, E, LinkAdmission | SessionAuthority>) =>
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
	const secretsLayer = Secrets.layer(declared_secrets(artifact.manifest)).pipe(
		Layer.provideMerge(Layer.merge(Layer.succeed(TenantDb, db), Keys.fromAbi(host.keys)))
	);
	const managerLayer = Layer.effect(
		LinkManagerService,
		Effect.gen(function* () {
			const secretService = yield* Secrets;
			const sealed = yield* credentials(db, secretService);
			const secrets = Object.fromEntries(
				(yield* Effect.forEach(declared_secrets(artifact.manifest), (name) =>
					Config.option(Config.String(name)).pipe(
						Effect.provideService(ConfigProvider.ConfigProvider, secretService.config),
						Effect.map((value) => (Option.isSome(value) ? [[name, value.value] as const] : []))
					)
				)).flat()
			);
			const port = credentialPort(sealed, encodedPromise<never>(yield* FiberSet.makeRuntimePromise()));
			const wrapped = host.credentials?.(port);
			const through =
				wrapped === undefined
					? sealed
					: {
							open: (instance: string) => hosted(() => wrapped.open(instance)),
							read: (instance: string) => hosted(() => wrapped.read(instance)),
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
			return yield* integration_links({
				providers: host.providers,
				credentials: through,
				public_url: host.public_url,
				secrets,
				oauth: host.oauth,
				fetch: host.fetch,
				tcp: host.tcp,
				...(host.log === undefined ? {} : { log: host.log }),
				enter: on(host.enter),
				admit: on(host.admit)
			});
		})
	).pipe(Layer.provideMerge(secretsLayer));
	const runtime = ManagedRuntime.make(
		managerLayer.pipe(Layer.provideMerge(cryptoLayer), Layer.provideMerge(logging))
	);
	const context = yield* bootRuntime(runtime);
	// Requests retain their captured context runner; the other link operations keep the managed runtime's scope.
	const requestRun = effectPromise(Effect.runPromiseWith(context));
	const raw = effectPromise<ManagedRuntime.ManagedRuntime.Services<typeof runtime>>(runtime.runPromise);
	const run = encodedPromise<ManagedRuntime.ManagedRuntime.Services<typeof runtime>>(runtime.runPromise);
	const manager = Context.get(context, LinkManagerService),
		sealed = yield* Effect.provideContext(credentials(db, Context.get(context, Secrets)), context);
	const linked: WorkspaceLinks = {
		credentials: credentialPort(sealed, run),
		port: {
			send: (instance, message, signal, attachments) =>
				raw(manager.port.send(instance, message, attachments?.map(({ url, ...attachment }) => ({
					...attachment,
					...(url === undefined ? {} : { url: (expiry: number) => Port.attempt('files.url', () => url(expiry)) })
				}))), signal),
			typing: (instance, to, signal, on) =>
				raw(manager.port.typing(instance, to, on), signal),
			request: (instance, operation, signal) =>
				requestRun(manager.port.request(instance, operation), signal),
			read: (instance, sync, partition, cursor, signal) =>
				raw(manager.port.read(instance, sync, partition, cursor), signal),
			changed: (instance) => {
				runtime.runFork(
					manager.port.changed(instance).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
				);
			}
		},
		resume: ({ signal }) => run(manager.resume, signal),
		open: () => run(manager.open),
		close: () => guard(() => runtime.dispose()),
		hook: (request) =>
			run(
				Effect.gen(function* () {
					const incoming = new URL(request.url),
						base = new URL(host.public_url).pathname.replace(/\/+$/, '');
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
		admin: (request) =>
			run(
				on(host.enter)(authority_of(HttpServerRequest.fromWeb(request))).pipe(
					Effect.flatMap((authority) =>
						integration_routes(HttpServerRequest.fromWeb(request)).pipe(
							Effect.provideService(IntegrationManager, Option.some(manager)),
							Effect.provideService(SessionAuthority, {
								of: () => Effect.succeed(Option.fromNullishOr(authority))
							})
						)
					),
					Effect.map((answer) =>
						Option.isNone(answer) ? null : HttpServerResponse.toWeb(answer.value)
					)
				),
				request.signal
			)
	};
	return linked;
});
class LinkManagerService extends Context.Service<
	LinkManagerService,
	import('../engine/integrations/links.ts').LinkManager
>()('bolt/HostApiLinks') {}

/** This release's `HostApi` implementation, the one value a host imports from a release. */
export const HOST_API: HostApi = {
	guest_execution: 'source',
	version: HOST_API_VERSION,
	contract: CONTRACT,
	cookies: { session: COOKIES.session, preview: COOKIES.preview },
	cookie_site: cookie_site,
	needs_guest: (request) =>
		hostRun(needs_guest(HttpServerRequest.fromWeb(request.clone())), request.signal),
	verify: (release, options) => hostRun(Effect.asVoid(artifactOf(release)), options.signal),
	describe: (release, options) =>
		hostRun(
			Effect.map(artifactOf(release), ({ manifest }): ReleaseFacts => {
				const { secrets, issues } = activation_requirements(manifest);
				return {
					zone: manifest.workspace.tz,
					skills: Object.keys(manifest.agent.skills),
					pages: Object.entries(manifest.apps).flatMap(([app, spec]) =>
						Object.keys(spec.pages).map((page) => href(app, page))
					),
					secrets,
					issues,
					studio: {
						workspace: { secrets: manifest.workspace.secrets ?? {} },
						models: manifest.models,
						apps: Object.fromEntries(
							Object.entries(manifest.apps).map(([app, { shell, pages }]) => [
								app,
								{ ...(shell === undefined ? {} : { shell }), pages }
							])
						),
						policies: manifest.policies,
						automations: manifest.automations
					}
				};
			}),
			options.signal
		),
	frame_policy: (release, path, options) =>
		hostRun(
			Effect.map(artifactOf(release), (artifact) => frame_policy(artifact.manifest, path)),
			options.signal
		),
	schema: {
		slice: (release, options) =>
			hostRun(
				Effect.flatMap(artifactOf(release), (artifact) =>
					Schema.decodeEffect(Schema.fromJsonString(SchemaSlice))(JSON.stringify(schema_slice(artifact.manifest)))
				),
				options.signal
			),
		destructive: (applied, release, options) =>
			hostRun(
				Effect.all([Schema.decodeUnknownEffect(SchemaSliceSchema)(applied), artifactOf(release)]).pipe(
					Effect.flatMap(([slice, artifact]) => destructiveSteps(slice, artifact.manifest))
				),
				options.signal
			),
		carry: (input, options) =>
			hostRun(
				Schema.decodeUnknownEffect(MigrationCarry)(input).pipe(Effect.flatMap(carry_migrations)),
				options.signal
			)
	},
	activate: (ports, options) => hostRun(activate(ports), options.signal),
	branch: (ports, options) => hostRun(branch(ports), options.signal),
	links: (host, options) => hostRun(links(host), options.signal)
};
