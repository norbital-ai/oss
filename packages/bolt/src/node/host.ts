// `bolt dev --host`'s in-process host (plan 01): one release served over a host file's facilities through this
// release's own HOST_API: integration links, activation, deadline wakes and the cron clock. bolt-server makes the same
// calls on a release's cell.
import { Effect, FiberSet, Option, Result, Schema } from 'effect';
import {
	type ActiveWorkspace,
	type Facilities,
	type GuestIsolatesPort,
	HostApiFailure,
	is_off,
	off,
	type Release,
	scope_deadlines,
	type Serving,
	type WorkspaceLinks
} from '@norbital-ai/host-api';
import { BoltError, CODES, PHASES } from '../protocol/errors.ts';
import { HOST_API } from '../protocol/host-api.ts';
import { node_ports, type NodePorts } from './ports.ts';
import { cron_clock } from '@norbital-ai/host-api/node';

const isCode = Schema.is(Schema.Literals(CODES)),
	isPhase = Schema.is(Schema.Literals(PHASES));
/** A HOST_API rejection (an encoded `HostApiFailure`) as the BoltError it names. */
const refused = (cause: unknown): BoltError =>
	Option.match(Schema.decodeUnknownOption(HostApiFailure)(cause), {
		onNone: () => BoltError.make('internal', 'facility', String(cause), cause),
		onSome: (failure) =>
			failure._tag === 'HostFailure' && isCode(failure.code) && isPhase(failure.phase)
				? BoltError.make(failure.code, failure.phase, failure.message)
				: BoltError.make('internal', 'facility', failure.message)
	});
/** One HOST_API call, its rejection decoded. */
export const call = <A>(work: (signal: AbortSignal) => Promise<A>) =>
	Effect.tryPromise({ try: work, catch: refused });

export type ServeOptions = {
	/** The deadlines scope and the log key. */
	readonly scope: string;
	readonly release: Release;
	readonly public_url: string;
	readonly facilities: Facilities;
	readonly serving: Serving;
	/** The host's guest runner (`node_guests` from `@norbital-ai/host-api/node` for `bolt dev`). */
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
	const deadlines = yield* scope_deadlines({
		wake: () => Effect.gen(function* () {
			const current = yield* call(() => generation.promise);
			yield* options.admit(call((signal) => current.wake({ signal })));
		}),
		// The active wake owns compute admission; a pulse only transfers a due notification to it.
		pulse: () => call(() => generation.promise).pipe(
			Effect.flatMap((current) => call((signal) => current.pulse({ signal })))
		)
	});
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
					mcp: options.native.mcp,
					bundler: off,
					convert: serving.convert ?? off,
					render: serving.render ?? off,
					geocoder: serving.geocoder ?? off,
					web: serving.web ?? off,
					browser: serving.browser ?? off,
					links: links.port,
					shell: { workspace: () => options.workspace, ...serving.shell },
					agent: serving.host_tools === undefined ? {} : { host_tools: serving.host_tools }
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
