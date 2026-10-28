// An untethered in-process host (plan 01): a workspace's `norbital.host.ts` loaded, and one release served over its
// facilities through the engine's own paths: integration links, activation, deadline wakes and the cron clock.
// bolt-server and `bolt dev --host` both serve through it; Colony makes the same engine calls across its tenants.
import { Clock, Effect, FiberSet, FileSystem, Option, Path, Queue, Result, Schema } from 'effect';
import { pathToFileURL } from 'node:url';
import { HOST_FILE } from '../compiler/artifact/index.ts';
import { activate, isOff, off, type Facilities, type Serving } from '../facilities/index.ts';
import { BoltError, CODES } from '../protocol/errors.ts';
import {
	HOST_API,
	HostApiFailure,
	type ActiveWorkspace,
	type Release,
	type WorkspaceLinks
} from '../protocol/host-api.ts';
import { cronClock } from './cron-clock.ts';
import type { NodePorts } from './ports.ts';


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

/** `flag`'s host file, else `root`'s own `norbital.host.ts`; none means the tethered loop. */
export const hostFileOf = Effect.fn('bolt.hostFileOf')(function* (
	root: string,
	flag: string | undefined
) {
	const path = yield* Path.Path,
		fs = yield* FileSystem.FileSystem;
	if (flag !== undefined) return Option.some(path.resolve(flag));
	const own = path.join(root, HOST_FILE);
	return (yield* fs.exists(own)) ? Option.some(own) : Option.none<string>();
});

const groups = ['storage', 'logs', 'transactional', 'intelligence', 'ports', 'sandbox', 'keys'];
const HostModule = Schema.Struct({
	default: Schema.declare(
		(input): input is Facilities =>
			typeof input === 'object' && input !== null && groups.every((group) => group in input)
	),
	serving: Schema.optionalKey(
		Schema.declare((input): input is Serving => typeof input === 'object' && input !== null)
	)
});
/** A host file's default `Facilities` and optional `serving`; closed with the scope. */
export const loadHost = Effect.fn('bolt.loadHost')(function* (file: string) {
	const module = yield* Effect.tryPromise({
		try: () => import(pathToFileURL(file).href),
		catch: (cause) => BoltError.make('invalidSpec', 'admission', `${file} could not load.`, cause)
	}).pipe(
		Effect.flatMap((module) => Schema.decodeUnknownEffect(HostModule)(module)),
		Effect.mapError((cause) =>
			BoltError.make(
				'invalidSpec',
				'admission',
				`${file} must default-export its Facilities (every group, \`off\` where left out).`,
				cause
			)
		)
	);
	const serving = module.serving ?? {};
	const close = serving.close;
	if (close !== undefined) yield* Effect.addFinalizer(() => Effect.promise(() => close()));
	return { facilities: module.default, serving };
});

export type ServeOptions = {
	/** The deadlines scope and the log key. */
	readonly scope: string;
	readonly release: Release;
	readonly publicUrl: string;
	readonly facilities: Facilities;
	readonly serving: Serving;
	readonly native: NodePorts;
	/** The shell's workspace name and handle. */
	readonly workspace: { readonly name: string; readonly handle: string };
	/** The seed pack's `start` runs. */
	readonly start?: readonly string[];
	/** Runs guest work under the host's compute envelope: link ingress, deadline wakes and cron fires. */
	readonly admit: <A, E>(work: Effect.Effect<A, E>) => Effect.Effect<A, E | BoltError>;
	readonly log: (line: string) => void;
};
export type Generation = { readonly workspace: ActiveWorkspace; readonly links: WorkspaceLinks };

/** One release served until the scope closes: its links, the activation, deadline wakes and crons. */
export const serveRelease = Effect.fn('bolt.serveRelease')(function* (options: ServeOptions) {
	const { facilities, serving, release, publicUrl } = options;
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
					publicUrl,
					providers: serving.providers ?? [],
					...(serving.oauth === undefined ? {} : { oauth: serving.oauth }),
					enter: (work) => generation.promise.then(work),
					admit: (work) =>
						generation.promise.then((workspace) =>
							run(options.admit(Effect.promise(() => work(workspace))))
						),
					fetch: globalThis.fetch,
					tcp: isOff(facilities.ports.outbound)
						? {
								connect: () =>
									Promise.reject(
										BoltError.make('unavailable', 'facility', 'This host serves no outbound network.')
									)
							}
						: facilities.ports.outbound.tcp,
					log: options.log
				},
				{ signal }
			)
		),
		(links) => Effect.promise(() => links.close())
	);
	// deadlines: the engine announces and settles the next due wake; one fiber sleeps until it
	const nudge = yield* Queue.sliding<void>(1);
	let due: number | null = null;
	const workspace = yield* Effect.acquireRelease(
		call((signal) =>
			activate(
				{
					scope: options.scope,
					release,
					publicUrl,
					...(options.start === undefined ? {} : { start: options.start }),
					guestIsolates: options.native.guestIsolates,
					deadlines: {
						announce: (_scope, notLaterThan) => {
							const next = Date.parse(notLaterThan);
							if (due !== null && due <= next) return;
							due = next;
							Queue.offerUnsafe(nudge, undefined);
						},
						settle: (_scope, nextDue) => {
							due = nextDue === null ? null : Date.parse(nextDue);
							Queue.offerUnsafe(nudge, undefined);
						},
						teardown: () => {
							due = null;
						}
					},
					images: options.native.images,
					docs: options.native.docs,
					mcp: options.native.mcp,
					bundler: off,
					convert: serving.convert ?? off,
					geocoder: serving.geocoder ?? off,
					web: serving.web ?? off,
					browser: off,
					links: links.port,
					shell: { workspace: () => options.workspace, ...serving.shell },
					agent: {}
				},
				facilities,
				{ signal }
			)
		),
		(workspace) => Effect.promise(() => workspace.close())
	);
	generation.resolve(workspace);
	yield* call((signal) => links.resume({ signal }));
	yield* Effect.gen(function* () {
		while (true) {
			const wake = due;
			if (wake === null) {
				yield* Queue.take(nudge);
				continue;
			}
			const wait = wake - (yield* Clock.currentTimeMillis);
			if (wait > 0) {
				yield* Queue.take(nudge).pipe(Effect.timeoutOption(wait));
				continue;
			}
			due = null;
			yield* options
				.admit(call((signal) => workspace.wake({ signal })))
				.pipe(Effect.catchCause((cause) => Effect.logWarning('deadline wake failed', cause)));
		}
	}).pipe(Effect.forkScoped);
	yield* cronClock({
		crons: Effect.promise(() => workspace.crons()),
		fire: (id, slot) => options.admit(call((signal) => workspace.fire(id, slot, { signal })))
	});
	const served: Generation = { workspace, links };
	return served;
});
