// One workspace's built release served from this process, as Colony serves one: the release's own Bolt (its
// `build/cell.js`) evaluated in a cell (`vm_cell`) and driven only through HOST_API — verify, branch and migrate, links,
// activate — over the facilities of its host file (`norbital.host.ts`). This process owns admission, the deadline and
// cron clocks, the static pages and the HTTP listener around the `ActiveWorkspace` the release answers.
import { BlockList, isIP } from 'node:net';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
	ByteSize,
	Clock,
	Context,
	Effect,
	FiberSet,
	FileSystem,
	Layer,
	Option,
	Result,
	Schema
} from 'effect';
import {
	HttpIncomingMessage,
	HttpMiddleware,
	HttpServerRequest,
	HttpServerResponse
} from 'effect/http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import {
	type ActiveWorkspace,
	ArtifactHeader,
	client_page,
	HOST_API_VERSION,
	HOST_LIMITS,
	HostApiFailure,
	is_off,
	off,
	type Release,
	scope_deadlines,
	supports,
	Unavailable
} from '@norbital-ai/host-api';
import {
	artifact_port,
	cron_clock,
	host_file_of,
	images_port,
	load_host,
	mcp_port,
	node_guests,
	vm_cell
} from '@norbital-ai/host-api/node';
import { envelope } from './envelope.ts';

export type ServeOptions = {
	/** The workspace directory: its `norbital.host.ts` serves it unless `hostFile` names another; its installed
	 * `@norbital-ai/bolt` is the release's runtime. */
	readonly workspace: string;
	/** The built release directory (`<workspace>/.norbital/bundle`). */
	readonly artifact: string;
	/** The host file: default-exports the Facilities, optionally exports `serving`. */
	readonly hostFile?: string;
	readonly host: string;
	readonly port: number;
	/** CIDRs whose `x-forwarded-for` is believed. */
	readonly trustProxy: readonly string[];
	/** An address made the workspace's founder at start. */
	readonly founder?: string;
	/** A seed pack of the release by name (`base`), loaded into an empty database. */
	readonly seed?: string;
	readonly maxConcurrent?: number;
	readonly log?: (line: string) => void;
};

/** What this server refuses or answers: its own refusal, or a release's rejection by its code. */
export class ServerError extends Schema.TaggedError<ServerError>()('ServerError', {
	code: Schema.String,
	message: Schema.String
}) {}
const refuse = (message: string) => new ServerError({ code: 'invalid_spec', message });

/** One HOST_API call; a rejection is the release's encoded `HostApiFailure`, anything else an internal failure. */
const call = <A>(work: (signal: AbortSignal) => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: (cause) =>
			Option.match(Schema.decodeUnknownOption(HostApiFailure)(cause), {
				onNone: () => new ServerError({ code: 'internal', message: String(cause) }),
				onSome: (failure) =>
					new ServerError({
						code: failure._tag === 'HostFailure' ? failure.code : 'internal',
						message: failure.message
					})
			})
	});

/** The client address: the TCP peer, stepping right to left through X-Forwarded-For while the hop is trusted. */
export const client_address = (
	peer: string,
	forwardedFor: string | undefined,
	trusted: readonly string[]
): string => {
	const subnets = new BlockList();
	// a malformed entry trusts nothing
	for (const cidr of trusted) {
		const [net = '', bits] = cidr.split('/');
		const version = isIP(net),
			max = version === 6 ? 128 : 32,
			prefix = bits === undefined ? max : Number(bits);
		if (version !== 0 && Number.isInteger(prefix) && prefix >= 0 && prefix <= max)
			subnets.addSubnet(net, prefix, version === 6 ? 'ipv6' : 'ipv4');
	}
	const isTrusted = (address: string) => {
		const version = isIP(address);
		return version !== 0 && subnets.check(address, version === 6 ? 'ipv6' : 'ipv4');
	};
	const hops = (forwardedFor ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter((s) => s !== '');
	let address = peer;
	while (isTrusted(address)) {
		const next = hops.pop();
		if (next === undefined) break;
		address = next;
	}
	return address;
};

export class Server extends Context.Service<
	Server,
	{ readonly url: string; readonly workspace: ActiveWorkspace }
>()('bolt-server/Server') {}

const STATUS: { readonly [code: string]: number } = {
	invalid_input: 400,
	forbidden: 403,
	not_found: 404,
	rate_limited: 429,
	busy: 503,
	unavailable: 503,
	timeout: 504
};
const json = (code: string, message: string, status: number) =>
	HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });
const missing = () => new Response(null, { status: 404 });

// Static client bytes only: workspace responses can contain secrets or stream live data.
const compressAssets = HttpMiddleware.compression({
	algorithms: ['br', 'gzip'],
	levels: { br: 4 },
	compressible: (type) => /^(?:text\/(?:javascript|css)|application\/javascript)(?:;|$)/.test(type)
});

/** The process scope owns the host file's resources, the cell, admission, the served release and the HTTP listener. */
export const ServerLive = (options: ServeOptions) =>
	Layer.effect(
		Server,
		Effect.gen(function* () {
			const log = options.log ?? ((line: string) => console.log(`[bolt] ${line}`));
			const fs = yield* FileSystem.FileSystem;
			const listening = `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}`;
			const admitted = yield* envelope(options.maxConcurrent ?? 8);
			const hostFile = yield* host_file_of(options.workspace, options.hostFile);
			if (Option.isNone(hostFile))
				return yield* refuse(
					`${options.workspace} has no norbital.host.ts: write one (or pass --host=<file>), or let Colony serve it`
				);
			const { facilities, serving } = yield* load_host(hostFile.value).pipe(
				Effect.mapError((failure) => refuse(failure.message))
			);
			const header = yield* fs.readFileString(join(options.artifact, 'artifact.json')).pipe(
				Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ArtifactHeader))),
				Effect.mapError(() => refuse(`${options.artifact} holds no built release; run bolt build`))
			);
			// the release's own Bolt, as the workspace installed its pin: its cell bundle and API reference
			// ponytail: the workspace's installed pin; a host serving releases apart from their checkout stores each runtime
			const bolt = join(options.workspace, 'node_modules', '@norbital-ai', 'bolt', 'build');
			const source = yield* fs
				.readFileString(join(bolt, 'cell.js'))
				.pipe(
					Effect.mapError(() =>
						refuse(`${options.workspace} has no installed @norbital-ai/bolt with a cell bundle`)
					)
				);
			const cell = yield* Effect.acquireRelease(
				Effect.try({
					try: () => vm_cell(source, (_error, line) => log(`[cell] ${line}`)),
					catch: (cause) => refuse(`The release's cell did not open: ${String(cause)}`)
				}),
				(cell) => Effect.sync(() => cell.close())
			);
			const api = cell.api;
			if (!supports({ from: HOST_API_VERSION, to: HOST_API_VERSION }, api.version))
				return yield* refuse(
					`The release speaks HOST_API ${api.version}; this server serves HOST_API ${HOST_API_VERSION}`
				);
			if (api.contract !== header.contract)
				return yield* refuse('The release was not built by its pinned Bolt; rebuild it with that release');
			const public_url = is_off(facilities.ports.webhooks)
				? listening
				: facilities.ports.webhooks.public_url;
			const release: Release = {
				id: header.hash,
				artifact: artifact_port(options.artifact, join(bolt, 'docs'))
			};
			yield* call((signal) => api.verify(release, { signal }));
			const branch = yield* call((signal) =>
				api.branch(
					{ release, database: facilities.storage.database, audit: facilities.logs.audit },
					{ signal }
				)
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
				log(
					step === 'loaded'
						? `--seed: loaded pack ${seed}`
						: '--seed: the database has rows; nothing seeded'
				);
			}
			const founder = options.founder;
			if (founder !== undefined)
				yield* call((signal) => branch.identity.founder(founder, { signal, at }));

			// the generation every link, deadline and cron enters once it is active
			const generation = Promise.withResolvers<ActiveWorkspace>();
			const runtime = yield* FiberSet.makeRuntimePromise<never>();
			const run = <A, E>(effect: Effect.Effect<A, E>) =>
				runtime(Effect.result(effect)).then(Result.getOrThrow);
			const outbound = facilities.ports.outbound;
			const links = yield* Effect.acquireRelease(
				call((signal) =>
					api.links(
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
									run(admitted.admit(1, Effect.promise(() => work(workspace))))
								),
							fetch: globalThis.fetch,
							tcp: is_off(outbound)
								? {
										connect: () =>
											Promise.reject(
												new Unavailable({
													facility: 'tcp',
													reason: 'This host serves no outbound network.'
												})
											)
									}
								: outbound.tcp,
							log
						},
						{ signal }
					)
				),
				(links) => Effect.tryPromise(() => links.close()).pipe(Effect.ignore)
			);
			const deadlines = yield* scope_deadlines({
				wake: () =>
					Effect.gen(function* () {
						const current = yield* call(() => generation.promise);
						yield* admitted.admit(1, call((signal) => current.wake({ signal })));
					}),
				// the active wake owns admission; a pulse only hands a due notification to it
				pulse: () =>
					call(() => generation.promise).pipe(
						Effect.flatMap((current) => call((signal) => current.pulse({ signal })))
					)
			});
			const mcp = yield* mcp_port;
			const workspace = yield* Effect.acquireRelease(
				call((signal) =>
					api.activate(
						{
							facilities,
							scope: 'start',
							release,
							public_url,
							// operator-trusted guest code, in `node:vm` contexts of this process
							guests: node_guests(),
							deadlines: {
								announce: (scope, at) => run(deadlines.announce(scope, at)),
								settle: (scope, at) => run(deadlines.settle(scope, at)),
								teardown: (scope) => run(deadlines.teardown(scope))
							},
							images: images_port,
							mcp,
							bundler: off,
							convert: serving.convert ?? off,
							render: serving.render ?? off,
							geocoder: serving.geocoder ?? off,
							web: serving.web ?? off,
							browser: serving.browser ?? off,
							links: links.port,
							shell: { workspace: () => ({ name: header.name, handle: header.handle }), ...serving.shell },
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
				fire: (id, slot) => admitted.admit(1, call((signal) => workspace.fire(id, slot, { signal })))
			});

			/** Integration hooks, the integrations admin, then the workspace: guest work in the interactive lane. */
			const route = (request: Request, path: string, address: string) =>
				Effect.gen(function* () {
					if (path.startsWith('/hooks/integration/') || path === '/hooks/oauth/callback')
						return (yield* call(() => links.hook(request))) ?? missing();
					if (path === '/__bolt/integrations' || path.startsWith('/__bolt/integrations/'))
						return (yield* call(() => links.admin(request))) ?? missing();
					const guest = yield* call(() => api.needs_guest(request.clone())).pipe(
						Effect.orElseSucceed(() => true)
					);
					const handle = call(() => workspace.handle(request, { address }));
					const handled = yield* guest ? admitted.admit(0, handle) : handle;
					return (
						handled ??
						(yield* admitted.admit(
							0,
							call((signal) => workspace.render(request, { address, signal }))
						))
					);
				});
			const handle = Effect.gen(function* () {
				const incoming = yield* HttpServerRequest.HttpServerRequest;
				const address = client_address(
					Option.getOrElse(incoming.remoteAddress, () => '0.0.0.0'),
					incoming.headers['x-forwarded-for'],
					options.trustProxy
				);
				const path = new URL(incoming.url, public_url).pathname;
				const request = yield* HttpServerRequest.toWeb(incoming);
				const response = yield* route(request, path, address);
				if (response !== null) return HttpServerResponse.fromWeb(response);
				if (path.startsWith('/__bolt/')) return json('not_found', 'No such route.', 404);
				const page = yield* client_page(options.artifact, path);
				if (page === undefined) return HttpServerResponse.empty({ status: 404 });
				if (!page.document)
					return yield* compressAssets(HttpServerResponse.file(page.file, { headers: page.headers }));
				const policy = yield* call((signal) => api.frame_policy(release, path, { signal }));
				return yield* HttpServerResponse.file(page.file, {
					headers: { ...page.headers, 'content-security-policy': policy }
				});
			}).pipe(
				Effect.catchTags({
					ServerError: (error) =>
						error.code === 'internal'
							? Effect.logWarning(error.message).pipe(
									Effect.as(json('internal', 'The request failed.', 500))
								)
							: Effect.succeed(json(error.code, error.message, STATUS[error.code] ?? 500)),
					Unavailable: (error) => Effect.succeed(json('unavailable', error.reason, 503))
				}),
				Effect.catchCause((cause) =>
					Effect.logWarning(cause).pipe(Effect.as(json('internal', 'The request failed.', 500)))
				)
			);
			const http = yield* NodeHttpServer.make(() => createServer(), {
				host: options.host,
				port: options.port,
				gracefulShutdownTimeout: '10 seconds'
			});
			yield* http.serve(
				Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
					handle.pipe(
						Effect.provideService(
							HttpIncomingMessage.MaxBodySize,
							ByteSize.bytes(
								new URL(request.url, public_url).pathname.startsWith('/__bolt/files/')
									? HOST_LIMITS.storedFileBytes
									: HOST_LIMITS.argsBytes + 1024 * 1024
							)
						)
					)
				)
			);
			yield* Effect.addFinalizer(() => admitted.drain(10_000).pipe(Effect.asVoid));
			const url =
				http.address._tag !== 'UnixPathAddress'
					? `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${http.address.port}`
					: public_url;
			return { url, workspace };
		})
	).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices));
