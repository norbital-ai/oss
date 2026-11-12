// An untethered in-process host (plan 01): a workspace's `norbital.host.ts` loaded, and one release served over its
// facilities through the engine's own paths: integration links, activation, deadline wakes and the cron clock.
// bolt-server and `bolt dev --host` both serve through it; Colony makes the same engine calls across its tenants.
import { Clock, Context, Effect, FiberSet, FileSystem, Layer, Option, Path, Result, Schema } from 'effect';
import { pathToFileURL } from 'node:url';
import { is_off, off, type Facilities, type Serving } from '../facilities/index.ts';
import { BoltError, CODES } from '../protocol/errors.ts';
import {
	HOST_API,
	HostApiFailure,
	type ActiveWorkspace,
	type Release,
	type WorkspaceLinks
} from '../protocol/host-api.ts';
import { cron_clock } from './cron-clock.ts';
import type { GuestIsolatesPort } from '../engine/contracts.ts';
import { node_ports, type NodePorts } from './ports.ts';
import { DeadlinePort } from '../engine/ports.ts';
import { in_process_deadlines } from '../engine/runs/deadlines.ts';
import { hostModule } from './host-module.ts';
import { read_artifact } from '../engine/artifact/read.ts';
import { render_mode } from '../protocol/pages.ts';
import { artifact_port } from './artifact.ts';
import { local_audit } from './audit.ts';
import { local_files } from './files.ts';
import { keys_port } from './keys.ts';
import { http_port } from './net.ts';
import { tcp_port } from './tcp.ts';

const isCode = Schema.is(Schema.Literals(CODES));
/** A HOST_API rejection (an encoded `HostApiFailure`) as the BoltError it names. */
const refused = (cause: unknown): BoltError =>
	Option.match(Schema.decodeUnknownOption(HostApiFailure)(cause), {
		onNone: () => BoltError.make('internal', 'facility', String(cause), cause),
		onSome: (failure) =>
			failure._tag === 'HostFailure' && isCode(failure.code)
				? BoltError.make(failure.code, failure.phase, failure.message)
				: BoltError.make('internal', 'facility', failure.message)
	});
/** One HOST_API call, its rejection decoded. */
export const call = <A>(work: (signal: AbortSignal) => Promise<A>) =>
	Effect.tryPromise({ try: work, catch: refused });

/** The host file a workspace serves untethered with (plan 01); never part of its source. */
export const HOST_FILE = 'norbital.host.ts';

/** `flag`'s host file, else `root`'s own `norbital.host.ts`; none means the tethered loop. */
export const host_file_of = Effect.fn('bolt.host_file_of')(function* (
	root: string,
	flag: string | undefined
) {
	const path = yield* Path.Path,
		fs = yield* FileSystem.FileSystem;
	if (flag !== undefined) return Option.some(path.resolve(flag));
	const own = path.join(root, HOST_FILE);
	return (yield* fs.exists(own)) ? Option.some(own) : Option.none<string>();
});

/** A host file's default `Facilities` and optional `serving`; closed with the scope. */
export const load_host = Effect.fn('bolt.load_host')(function* (file: string) {
	const module = yield* Effect.tryPromise({
		try: (): Promise<unknown> => import(pathToFileURL(file).href),
		catch: (cause) =>
			BoltError.make(
				'invalid_spec',
				'admission',
				`${file} could not load: ${cause instanceof Error ? cause.message : String(cause)}`,
				cause
			)
	}).pipe(
		Effect.flatMap((module) =>
			Effect.try({
				try: () => hostModule(module),
				catch: (cause) =>
					BoltError.make(
						'invalid_spec',
						'admission',
						`${file} must default-export its Facilities (every group, \`off\` where left out).`,
						cause
					)
			})
		)
	);
	const serving = module.serving;
	const close = serving.close;
	if (close !== undefined) yield* Effect.addFinalizer(() => Effect.promise(() => close()));
	return module;
});

export type ServeOptions = {
	/** The deadlines scope and the log key. */
	readonly scope: string;
	readonly release: Release;
	readonly public_url: string;
	readonly facilities: Facilities;
	readonly serving: Serving;
	/** The host's guest runner (`node_guests` from `@norbital-ai/bolt-cli/guests` for bolt-server and `bolt dev`). */
	readonly guests: GuestIsolatesPort;
	readonly native: NodePorts;
	/** The shell's workspace name and handle. */
	readonly workspace: { readonly name: string; readonly handle: string };
	/** Runs guest work under the host's compute envelope: link ingress, deadline wakes and cron fires. */
	readonly admit: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, E | BoltError>;
	readonly log: (line: string) => void;
};
export type Generation = { readonly workspace: ActiveWorkspace; readonly links: WorkspaceLinks };

/** One release served until the scope closes: its links, the activation, deadline wakes and crons. */
export const serve_release = Effect.fn('bolt.serve_release')(function* (options: ServeOptions) {
	const { facilities, serving, release, public_url } = options;
	const generation = Promise.withResolvers<ActiveWorkspace>();
	const runtime = yield* FiberSet.makeRuntimePromise<never>();
	const run = <A, E>(effect: Effect.Effect<A, E>) =>
		runtime(Effect.result(effect)).then(Result.getOrThrow);
	const links = yield* Effect.acquireRelease(
		call((signal) =>
			HOST_API.links(
				{
					release,
					database: facilities.storage.database,
					keys: facilities.keys,
					public_url,
					providers: serving.providers ?? [],
					...(serving.oauth === undefined ? {} : { oauth: serving.oauth }),
					enter: (work) => generation.promise.then(work),
					admit: (work) =>
						generation.promise.then((workspace) =>
							run(options.admit(Effect.promise(() => work(workspace))))
						),
					fetch: globalThis.fetch,
					tcp: is_off(facilities.ports.outbound)
						? {
								connect: () =>
									Promise.reject(
										BoltError.make(
											'unavailable',
											'facility',
											'This host serves no outbound network.'
										)
									)
							}
						: facilities.ports.outbound.tcp,
					log: options.log
				},
				{ signal }
			)
		),
		(links) => Effect.tryPromise(() => links.close()).pipe(Effect.ignore)
	);
	const deadlines = Context.get(yield* Layer.build(in_process_deadlines({
		wake: () => Effect.gen(function* () {
			const current = yield* call(() => generation.promise);
			yield* options.admit(call((signal) => current.wake({ signal })));
		}),
		// The active wake owns compute admission; a pulse only transfers a due notification to it.
		pulse: () => call(() => generation.promise).pipe(
			Effect.flatMap((current) => call((signal) => current.pulse({ signal })))
		)
	})), DeadlinePort);
	const workspace = yield* Effect.acquireRelease(
		call((signal) =>
			HOST_API.activate(
				{
					facilities,
					scope: options.scope,
					release,
					public_url,
					guests: options.guests,
					deadlines: {
						announce: (scope, at) => run(deadlines.announce(scope, at)),
						settle: (scope, at) => run(deadlines.settle(scope, at)),
						teardown: (scope) => run(deadlines.teardown(scope))
					},
					images: options.native.images,
					docs: options.native.docs,
					mcp: options.native.mcp,
					bundler: off,
					convert: serving.convert ?? off,
					geocoder: serving.geocoder ?? off,
					web: serving.web ?? off,
					browser: serving.browser ?? off,
					links: links.port,
					shell: { workspace: () => options.workspace, ...serving.shell },
					agent: {
						...(serving.ingest === undefined ? {} : { ingest: serving.ingest }),
						...(serving.host_tools === undefined ? {} : { host_tools: serving.host_tools })
					}
				},
				{ signal }
			)
		),
		(workspace) => Effect.tryPromise(() => workspace.close()).pipe(Effect.ignore)
	);
	generation.resolve(workspace);
	yield* call((signal) => links.resume({ signal }));
	const crons = yield* call(() => workspace.crons());
	yield* cron_clock({
		crons: Effect.succeed(crons),
		fire: (id, slot) => options.admit(call((signal) => workspace.fire(id, slot, { signal })))
	});
	const served: Generation = { workspace, links };
	return served;
});

/**
 * One workspace served untethered from this process (bolt-server): its host file (`host_file`, else
 * `<workspace>/norbital.host.ts`) loaded, the built release at `artifact` verified, migrated, optionally seeded and
 * founded, then served until the scope closes. `handle` answers a request at `path`: integration hooks, the
 * integrations admin, then the workspace, a guest's work in `admit`'s interactive lane; `null` leaves the request to
 * the host's static pages.
 */
export const serve = Effect.fn('bolt.serve')(function* (options: {
	readonly workspace: string;
	readonly host_file?: string | undefined;
	/** The built release directory. */
	readonly artifact: string;
	/** The listener's own origin: the public URL when the host file serves no webhooks. */
	readonly listening: string;
	/** The host's guest runner. */
	readonly guests: GuestIsolatesPort;
	/** A seed pack of the release by name, loaded into an empty database. */
	readonly seed?: string | undefined;
	/** An address made the workspace's founder. */
	readonly founder?: string | undefined;
	/** The host's compute envelope: lane 0 is interactive, lane 1 background work. */
	readonly admit: <A, E>(lane: 0 | 1, work: Effect.Effect<A, E>) => Effect.Effect<A, E | BoltError>;
	readonly log: (line: string) => void;
}) {
	const host_file = yield* host_file_of(options.workspace, options.host_file);
	if (Option.isNone(host_file))
		return yield* BoltError.make(
			'invalid_spec',
			'admission',
			`${options.workspace} has no norbital.host.ts: write one (or pass --host=<file>), or let Colony serve it`
		);
	const { facilities, serving } = yield* load_host(host_file.value);
	const artifact = yield* read_artifact(options.artifact),
		manifest = artifact.manifest;
	const public_url = is_off(facilities.ports.webhooks)
		? options.listening
		: facilities.ports.webhooks.public_url;
	const release: Release = { id: artifact.artifact.hash, artifact: artifact_port(artifact.dir) };
	yield* call((signal) => HOST_API.verify(release, { signal }));
	const branch = yield* call((signal) =>
		HOST_API.branch({ release, database: facilities.storage.database, audit: facilities.logs.audit }, { signal })
	);
	yield* call((signal) => branch.schema.migrate({ signal }));
	const at = new Date(yield* Clock.currentTimeMillis).toISOString();
	const seed = options.seed;
	if (seed !== undefined) {
		const load = yield* call((signal) =>
			branch.packs.load(seed, { signal, at, files: facilities.storage.files })
		);
		let step = yield* call((signal) => load.step({ signal }));
		while (step === 'more') step = yield* call((signal) => load.step({ signal }));
		options.log(
			step === 'loaded' ? `--seed: loaded pack ${seed}` : '--seed: the database has rows; nothing seeded'
		);
	}
	const founder = options.founder;
	if (founder !== undefined) yield* call((signal) => branch.identity.founder(founder, { signal, at }));
	const { workspace, links } = yield* serve_release({
		scope: 'start',
		release,
		public_url,
		facilities,
		serving,
		guests: options.guests,
		native: yield* node_ports(),
		workspace: { name: artifact.artifact.name, handle: artifact.artifact.handle },
		admit: (work) => options.admit(1, work),
		log: options.log
	});
	const missing = () => new Response(null, { status: 404 });
	const handle = (request: Request, path: string, address: string) =>
		Effect.gen(function* () {
			if (path.startsWith('/hooks/integration/') || path === '/hooks/oauth/callback')
				return (yield* call(() => links.hook(request))) ?? missing();
			if (path === '/__bolt/integrations' || path.startsWith('/__bolt/integrations/')) {
				const authority = yield* call((signal) =>
					workspace.identity.authority(request.clone(), { signal })
				);
				if (authority === null)
					return Response.json(
						{ error: { code: 'unauthenticated', message: 'Sign in to manage integrations.' } },
						{ status: 401 }
					);
				return (yield* call(() => links.admin(request, authority))) ?? missing();
			}
			const work = call(
				async (signal) =>
					(await workspace.handle(request, { address })) ??
					(await workspace.render(request, { address, signal }))
			);
			const guest =
				((request.method === 'GET' || request.method === 'HEAD') &&
					render_mode(manifest, path) !== null) ||
				(yield* call(() => HOST_API.needs_guest(request.clone())).pipe(
					Effect.catch(() => Effect.succeed(true))
				));
			return yield* guest ? options.admit(0, work) : work;
		});
	return { workspace, artifact, public_url, handle };
});

/**
 * This process's own facility parts for a host file (bolt-server's example): the durable audit database in `audit_dir`,
 * never the tenant's PGlite directory `pglite`; keys sealed by `master_key`; the public outbound network; and
 * content-addressed files in a local directory. The audit database closes with the scope.
 */
export const default_facilities = Effect.fn('bolt.default_facilities')(function* (config: {
	readonly audit_dir: string;
	readonly master_key: Uint8Array;
	readonly pglite?: string | undefined;
}) {
	const fs = yield* FileSystem.FileSystem;
	yield* fs.makeDirectory(config.audit_dir, { recursive: true });
	const audit_dir = yield* fs.realPath(config.audit_dir);
	if (config.pglite !== undefined && audit_dir === (yield* fs.realPath(config.pglite)))
		return yield* BoltError.make(
			'invalid_spec',
			'admission',
			'The audit database must be separate from the tenant database.'
		);
	return {
		audit: yield* local_audit(audit_dir),
		keys: keys_port(config.master_key),
		outbound: { http: http_port, tcp: tcp_port },
		local_files
	};
});
