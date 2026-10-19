/// <reference types="node" />
import {
	Clock,
	Config,
	ConfigProvider,
	Context,
	Deferred,
	Effect,
	FiberSet,
	FileSystem,
	Layer,
	Option,
	Path,
	Queue,
	Redacted,
	Result,
	Schema,
	Scope,
	ScopedRef,
	Semaphore,
	Stream
} from 'effect';
import {
	FetchHttpClient,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse
} from 'effect/unstable/http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { Artifact, Pack } from '../compiler/artifact/index.ts';
import { loadPackWithAssets, readPack, workspaceFiles } from '../compiler/artifact/index.ts';
import { PgliteDb } from '../engine/db/pglite.ts';
import { TenantDb } from '../engine/db/tenant-db.ts';
import { EngineLive, type EngineServices } from '../engine/host.ts';
import { Activation, Live, Runs } from '../engine/services.ts';
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
import { AgentHost } from '../engine/agent/index.ts';
import { declaredSecrets } from '../engine/manifest.ts';
import { Secrets } from '../engine/secrets.ts';
import { localFiles, loggedTransport } from '../engine/facilities.ts';
import { documentConverter } from '../engine/convert.ts';
import { inProcessDeadlines } from '../engine/runs/deadlines.ts';
import { credentials } from '../engine/integrations/credentials.ts';
import { BoltError } from '../protocol/errors.ts';
import { integrationLinks, type LinkManager } from '../engine/integrations/links.ts';
import type { Provider } from '../engine/integrations/driver.ts';
import {
	founderBootstrap,
	loadKeys,
	loggedPhone,
	makeIdentityHost,
	signupOf
} from '../engine/identity/session.ts';
import { RateWindows } from '../engine/access/rate.ts';
import { applyPlan, plan, readApplied } from '../engine/schema/plan.ts';
import { BoltHost, BoltHostLive } from '../protocol/host.ts';
import { PublicPages, publicPages } from '../protocol/pages.ts';
import { IntegrationManager } from '../protocol/integrations.ts';
import { clientPage } from '../protocol/static.ts';
import { basePath } from '../protocol/wire.ts';
import { RateLimits, responseError } from '../protocol/http.ts';
import { HostIdentity, ShellConfig, ShellRoutes, Turnstile } from '../shell/host.ts';
import { AuthorErrors, buildWorkspace, ToolFailure, type Log } from './build.ts';

export type DevOptions = {
	port?: number;
	seed?: string;
	bank?: string;
	founder?: string;
	db?: string;
	log: Log;
	watch?: boolean;
	providers?: readonly Provider[];
	publicUrl?: string;
};
export type DevHostOptions = {
	port: number;
	pack?: Pack;
	founder?: string;
	files: Files['Service'];
	convert?: Convert['Service'];
	log: Log;
	providers?: readonly Provider[];
	keyFile?: string;
	publicUrl?: string;
};
type DevGeneration = {
	readonly context: Context.Context<
		EngineServices | TenantDb | BoltHost | HostIdentity | PublicPages
	>;
	readonly artifact: Artifact;
	readonly manager: LinkManager;
};
export class DevHost extends Context.Service<
	DevHost,
	Readonly<Effect.Success<ReturnType<typeof makeDevHost>>>
>()('bolt/DevHost') {}

export const devConverter = Effect.gen(function* () {
	const config = yield* Config.all({
		provider: Config.option(Config.string('BOLT_CONVERT_PROVIDER')),
		endpoint: Config.option(Config.url('BOLT_CONVERT_ENDPOINT')),
		credential: Config.option(Config.redacted('BOLT_CONVERT_CREDENTIAL'))
	});
	if (Option.isNone(config.provider) || config.provider.value === '') {
		if (Option.isSome(config.endpoint) || Option.isSome(config.credential))
			return yield* Effect.fail(
				new ToolFailure({
					message: 'BOLT_CONVERT_ENDPOINT/CREDENTIAL without BOLT_CONVERT_PROVIDER'
				})
			);
		return Option.none<Convert['Service']>();
	}
	if (config.provider.value !== 'norbital')
		return yield* Effect.fail(
			new ToolFailure({
				message: 'BOLT_CONVERT_PROVIDER must be norbital'
			})
		);
	if (Option.isNone(config.endpoint))
		return yield* Effect.fail(
			new ToolFailure({ message: 'BOLT_CONVERT_PROVIDER needs BOLT_CONVERT_ENDPOINT' })
		);
	if (Option.isNone(config.credential))
		return yield* Effect.fail(
			new ToolFailure({ message: 'BOLT_CONVERT_PROVIDER needs BOLT_CONVERT_CREDENTIAL' })
		);
	if (!['http:', 'https:'].includes(config.endpoint.value.protocol))
		return yield* Effect.fail(
			new ToolFailure({ message: 'BOLT_CONVERT_ENDPOINT must use HTTP or HTTPS' })
		);
	return Option.some(
		documentConverter({
			url: config.endpoint.value.href,
			key: Redacted.value(config.credential.value)
		})
	);
});
const masterKey = Effect.fn('dev.masterKey')(function* (file: string, artifact: string) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	const keyPath = path.resolve(file),
		dir = path.resolve(artifact);
	if (keyPath === dir || keyPath.startsWith(dir + path.sep))
		return yield* Effect.fail(
			new ToolFailure({ message: 'The development master key must be outside the artifact.' })
		);
	yield* fs.makeDirectory(path.dirname(keyPath), { recursive: true });
	if (!(yield* fs.exists(keyPath)))
		yield* fs
			.writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 })
			.pipe(
				Effect.catch((error) =>
					fs
						.exists(keyPath)
						.pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error))))
				)
			);
	yield* fs.chmod(keyPath, 0o600);
	const key = yield* fs.readFile(keyPath);
	if (key.byteLength !== 32)
		return yield* Effect.fail(
			new ToolFailure({ message: 'The development master key must contain 32 bytes.' })
		);
	return Redacted.make(key);
});

const makeDevHost = (artifact: Artifact, options: DevHostOptions) =>
	Effect.gen(function* () {
		const db = yield* TenantDb,
			path = yield* Path.Path,
			fs = yield* FileSystem.FileSystem;
		const keyFile = path.resolve(
			options.keyFile ?? path.join(path.dirname(artifact.dir), 'cache', 'dev-master.key')
		);
		const key = yield* masterKey(keyFile, artifact.dir),
			publicUrl = options.publicUrl ?? `http://127.0.0.1:${options.port}`;
		const serial = yield* Semaphore.make(1),
			active = yield* ScopedRef.make(() => Option.none<DevGeneration>());
		const io = yield* Effect.context<
			FileSystem.FileSystem | Path.Path | import('effect/unstable/http/HttpPlatform').HttpPlatform
		>();
		const runProviderRuntime =
			yield* FiberSet.makeRuntimePromise<import('effect/unstable/http/HttpClient').HttpClient>();
		const runProviders = <A, E>(
			effect: Effect.Effect<A, E>,
			options?: { readonly signal?: AbortSignal | undefined }
		) => runProviderRuntime(Effect.result(effect), options).then(Result.getOrThrow);
		const providers =
			options.providers ??
			(yield* Effect.tryPromise({
				try: () => import('@norbital-ai/bolt-server'),
				catch: (cause) =>
					new ToolFailure({
						message: 'Native integration development requires @norbital-ai/bolt-server',
						cause
					})
			}).pipe(Effect.flatMap((server) => server.toDrivers(server.drivers(), runProviders))));
		const mail = loggedTransport('dev', options.log);
		const deadlines = inProcessDeadlines(() =>
			ScopedRef.get(active).pipe(
				Effect.flatMap((current) =>
					Option.isNone(current)
						? Effect.void
						: Effect.flatMap(Runs, (runs) => runs.tick).pipe(Effect.provide(current.value.context))
				)
			)
		);
		const acquire = Effect.fn('dev.activate')(function* (next: Artifact, pack?: Pack) {
			yield* masterKey(keyFile, next.dir);
			yield* applyPlan(db, plan(yield* readApplied(db), next.manifest), { accept: true });
			if (pack !== undefined)
				options.log(
					(yield* loadPackWithAssets(
						db,
						next.manifest,
						pack,
						options.files,
						new Date(yield* Clock.currentTimeMillis).toISOString()
					))
						? `seeded pack ${pack.meta.name}`
						: `pack ${pack.meta.name} not loaded: the database has rows`
				);
			const secretContext = yield* Layer.build(
				Secrets.layer(declaredSecrets(next.manifest), Option.some(key)).pipe(
					Layer.provide(Layer.succeed(TenantDb, db))
				)
			);
			const codec = Context.get(secretContext, Secrets);
			const ready = yield* Deferred.make<Context.Context<EngineServices | TenantDb>>();
			const secrets = Object.fromEntries(
				(yield* Effect.forEach(declaredSecrets(next.manifest), (name) =>
					Config.option(Config.string(name)).pipe(
						Effect.provideService(ConfigProvider.ConfigProvider, codec.config),
						Effect.map((value) => (Option.isSome(value) ? [[name, value.value] as const] : []))
					)
				)).flat()
			);
			const manager = yield* integrationLinks({
				providers,
				credentials: yield* credentials(db, codec),
				publicUrl,
				secrets,
				log: options.log,
				enter: (effect) =>
					Deferred.await(ready).pipe(
						Effect.flatMap((context) => effect.pipe(Effect.provide(context)))
					)
			});
			const workspace = yield* workspaceFiles(next.dir);
			const ports = Layer.mergeAll(
				Layer.succeed(AgentHost, workspace === undefined ? {} : { workspace }),
				Layer.succeed(TenantDb, db),
				Layer.succeed(Files, options.files),
				Layer.succeed(Transport, mail),
				options.convert === undefined
					? Convert.unavailable
					: Layer.succeed(Convert, options.convert),
				Ai.unavailable,
				Speech.unavailable,
				WebRead.unavailable,
				Geo.unavailable,
				Metering.unavailable,
				deadlines,
				Layer.succeed(Drivers, manager.port),
				Layer.succeed(IntegrationManager, Option.some(manager)),
				Layer.succeed(Activation, {
					scope: 'dev',
					epoch: '',
					release: next.artifact.hash,
					publicUrl,
					guest: Option.some(next.guest),
					transforms: new Set(next.transforms),
					projections: new Set(next.projections),
					start: pack?.meta.start ?? [],
					secretsKey: Option.some(key)
				})
			);
			const engineContext = yield* Layer.build(
				EngineLive(next.manifest).pipe(Layer.provideMerge(ports))
			);
			yield* Deferred.succeed(ready, engineContext);
			const engine = Layer.succeedContext(engineContext);
			const hostIdentity = Layer.effect(
				HostIdentity,
				Effect.gen(function* () {
					return yield* makeIdentityHost({
						db,
						now: Clock.currentTimeMillis.pipe(Effect.map((at) => new Date(at))),
						windows: new RateWindows(),
						keys: yield* loadKeys(db),
						publicUrl,
						mail: {
							send: (_kind, message, signal) =>
								runProviders(
									mail.send({
										_tag: 'Mail',
										...Schema.decodeUnknownSync(
											Schema.Struct({
												to: Schema.String,
												subject: Schema.String,
												text: Schema.String,
												html: Schema.optionalKey(Schema.String)
											})
										)(message)
									}),
									{ signal }
								)
						},
						phone: loggedPhone(options.log, true),
						devSink: true,
						...(signupOf(next.manifest) === undefined ? {} : { signup: signupOf(next.manifest) })
					});
				})
			);
			const shell = ShellRoutes.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						hostIdentity,
						Layer.succeed(ShellConfig, {
							publicUrl,
							workspace: { name: next.artifact.name, handle: next.artifact.handle },
							secure: false,
							ai: false
						}),
						Turnstile.dev,
						RateLimits.layer
					).pipe(Layer.provideMerge(engine))
				)
			);
			const context = yield* Layer.build(
				Layer.merge(BoltHostLive, publicPages(next)).pipe(Layer.provideMerge(shell))
			).pipe(Effect.provide(io));
			yield* Effect.addFinalizer(() => Context.get(context, Live).close(next.artifact.hash));
			return { context, artifact: next, manager };
		});
		const swap = (next: Artifact, pack?: Pack) =>
			serial.withPermit(
				Effect.gen(function* () {
					yield* ScopedRef.set(
						active,
						acquire(next, pack).pipe(Effect.provide(io), Effect.map(Option.some))
					);
					const current = yield* ScopedRef.get(active);
					if (Option.isSome(current)) yield* current.value.manager.resume;
				})
			);
		yield* ScopedRef.set(active, acquire(artifact, options.pack).pipe(Effect.map(Option.some)));
		const initial = yield* ScopedRef.get(active);
		if (Option.isSome(initial)) yield* initial.value.manager.resume;
		if (Option.isSome(initial) && options.founder !== undefined)
			yield* founderBootstrap(
				Context.get(initial.value.context, HostIdentity),
				options.founder
			).pipe(
				Effect.tap(() =>
					Effect.sync(() =>
						options.log(`founder ${options.founder}: sign in with code 123456 (dev sink)`)
					)
				)
			);
		return {
			url: publicUrl.replace(/\/+$/, ''),
			swap: (next: Artifact) => swap(next),
			handle: (request: HttpServerRequest.HttpServerRequest) =>
				Effect.gen(function* () {
					const current = yield* ScopedRef.get(active);
					if (Option.isNone(current)) return HttpServerResponse.empty({ status: 503 });
					const url = new URL(request.url, publicUrl),
						base = basePath(publicUrl);
					if (base !== '' && url.pathname !== base && !url.pathname.startsWith(base + '/'))
						return HttpServerResponse.empty({ status: 404 });
					const routePath = url.pathname.slice(base.length) || '/';
					const local = request.modify({ url: routePath + url.search });
					const response = yield* Context.get(current.value.context, BoltHost).handle(local);
					if (Option.isSome(response)) return response.value;
					const rendered = yield* Context.get(current.value.context, PublicPages).render(local);
					if (Option.isSome(rendered)) return rendered.value;
					const page = yield* clientPage(
						current.value.artifact.dir,
						routePath,
						current.value.artifact.manifest
					).pipe(Effect.provide(io));
					if (page === undefined) return HttpServerResponse.empty({ status: 404 });
					if (base !== '' && page.document) {
						const html = yield* fs.readFileString(page.file).pipe(Effect.provide(io));
						const escaped = base
							.replace(/&/g, '&amp;')
							.replace(/"/g, '&quot;')
							.replace(/</g, '&lt;');
						return HttpServerResponse.text(
							html.replace(
								'<head>',
								`<head><base href="${escaped}/"><meta name="bolt-base" content="${escaped}">`
							),
							{ headers: page.headers }
						);
					}
					return yield* HttpServerResponse.file(page.file, { headers: page.headers }).pipe(
						Effect.provide(io)
					);
				}).pipe(Effect.catch((error) => Effect.succeed(responseError(error))))
		};
	});

export const DevHostLive = (artifact: Artifact, options: DevHostOptions) =>
	Layer.effect(DevHost, makeDevHost(artifact, options)).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeHttpServer.layerHttpServices))
	);

const packOf = Effect.fn('dev.packOf')(function* (root: string, name: string) {
	if (name === 'none') return undefined;
	const path = yield* Path.Path;
	return yield* readPack(
		name === 'base' || name === 'sample'
			? path.join(root, '.norbital', 'seed', name)
			: path.resolve(name)
	);
});
export const dev = Effect.fn('bolt.dev')(function* (root: string, options: DevOptions) {
	const path = yield* Path.Path,
		convert = yield* devConverter;
	const initial = yield* buildWorkspace(root, {
		...(options.bank === undefined ? {} : { bank: options.bank }),
		types: false,
		log: options.log
	});
	const pack = yield* packOf(root, options.seed ?? 'base');
	const hostLayer = DevHostLive(initial.artifact, {
		port: options.port ?? 5180,
		files: localFiles(path.join(root, '.norbital', 'cache', 'dev-files')),
		keyFile:
			options.db === undefined
				? path.join(root, '.norbital', 'cache', 'dev-master.key')
				: path.join(path.resolve(options.db), 'bolt-master.key'),
		...(pack === undefined ? {} : { pack }),
		...(options.founder === undefined ? {} : { founder: options.founder }),
		...(Option.isNone(convert) ? {} : { convert: convert.value }),
		...(options.providers === undefined ? {} : { providers: options.providers }),
		...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
		log: options.log
	}).pipe(Layer.provideMerge(PgliteDb.layer(options.db)));
	const context = yield* Layer.build(hostLayer),
		host = Context.get(context, DevHost);
	const server = yield* NodeHttpServer.make(() => createServer(), {
		host: '127.0.0.1',
		port: options.port ?? 5180
	});
	yield* server
		.serve(Effect.flatMap(HttpServerRequest.HttpServerRequest, host.handle))
		.pipe(Effect.provide(NodeHttpServer.layerHttpServices));
	options.log(`dev ready: ${host.url}`);
	if (options.watch !== false) {
		const fs = yield* FileSystem.FileSystem,
			dirs = yield* Effect.filter(
				['src', 'seed'].map((dir) => path.join(root, dir)),
				(dir) => fs.exists(dir)
			);
		const changes = Stream.callback<void, ToolFailure>((queue) =>
			Effect.acquireRelease(
				Effect.try({
					try: () =>
						dirs.map((dir) =>
							watch(dir, { recursive: true }, () => Queue.offerUnsafe(queue, undefined))
						),
					catch: (cause) =>
						new ToolFailure({ message: 'The development watcher could not open.', cause })
				}),
				(watchers) =>
					Effect.sync(() => {
						for (const watcher of watchers) watcher.close();
					})
			)
		);
		yield* changes.pipe(
			Stream.debounce('150 millis'),
			Stream.runForEach(() =>
				buildWorkspace(root, { types: false }).pipe(
					Effect.flatMap((next) => host.swap(next.artifact)),
					Effect.tap(() => Effect.sync(() => options.log('reloaded'))),
					Effect.catch((error) =>
						Effect.sync(() =>
							options.log(
								error instanceof AuthorErrors
									? error.errors.map((diagnostic) => diagnostic.message).join('\n')
									: String(error)
							)
						)
					)
				)
			),
			Effect.forkScoped
		);
	}
	return host;
});
