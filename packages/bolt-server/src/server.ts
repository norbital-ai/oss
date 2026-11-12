// One Bolt workspace artifact served from one process with its host file (`norbital.host.ts`): the file's Facilities
// and `serving` parts, served through `serve_release` (`@norbital-ai/bolt/node`), the path `bolt dev --host` takes.
// This process owns admission and the HTTP listener around it.
import { ByteSize, Clock, Context, Effect, Fiber, Layer, Option } from 'effect';
import { HttpServerRequest, HttpServerResponse, HttpIncomingMessage, HttpMiddleware } from 'effect/http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { createServer } from 'node:http';
import { read_artifact } from '@norbital-ai/bolt/artifact';
import { client_address, client_page, render_mode, LIMITS, wire_error } from '@norbital-ai/bolt/engine';
import { is_off } from '@norbital-ai/bolt/facilities';
import { HOST_API, type ActiveWorkspace, type Release } from '@norbital-ai/bolt/host-api';
import { artifact_port, call, load_host, node_ports, serve_release } from '@norbital-ai/bolt/node';
import { node_guests } from '@norbital-ai/bolt-cli/guests';
import { envelope } from './envelope.ts';

export type ServeOptions = {
	/** The built release directory (`<workspace>/.norbital/bundle`). */
	readonly artifact: string;
	/** The host file: default-exports the Facilities, optionally exports `serving`. */
	readonly hostFile: string;
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

export class Server extends Context.Service<
	Server,
	{
		readonly url: string;
		readonly workspace: ActiveWorkspace;
	}
>()('bolt-server/Server') {}

const json = (code: string, message: string, status: number) =>
	HttpServerResponse.jsonUnsafe({ error: { code, message } }, { status });

// Static client bytes only: workspace responses can contain secrets or stream live data.
const compressAssets = HttpMiddleware.compression({
	algorithms: ['br', 'gzip'],
	levels: { br: 4 },
	compressible: (type) => /^(?:text\/(?:javascript|css)|application\/javascript)(?:;|$)/.test(type)
});

/** The process scope owns the host file's resources, admission, the served release and the HTTP listener. */
export const ServerLive = (options: ServeOptions) =>
	Layer.effect(
		Server,
		Effect.gen(function* () {
			const log = options.log ?? ((line: string) => console.log(`[bolt] ${line}`));
			const { facilities, serving } = yield* load_host(options.hostFile);
			const artifact = yield* read_artifact(options.artifact),
				manifest = artifact.manifest;
			const listening = `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}`;
			const public_url = is_off(facilities.ports.webhooks)
				? listening
				: facilities.ports.webhooks.public_url;
			const database = facilities.storage.database;
			const release: Release = { id: artifact.artifact.hash, artifact: artifact_port(artifact.dir) };
			yield* call((signal) => HOST_API.verify(release, { signal }));
			const branch = yield* call((signal) =>
				HOST_API.branch({ release, database, audit: facilities.logs.audit }, { signal })
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
			const admitted = yield* envelope(options.maxConcurrent ?? 8);
			const { workspace, links } = yield* serve_release({
				scope: 'start',
				release,
				public_url,
				facilities,
				serving,
				// this host's own guest runner, never the host file's: `node:vm` contexts for operator-trusted code
				guests: node_guests(),
				native: yield* node_ports(),
				workspace: { name: artifact.artifact.name, handle: artifact.artifact.handle },
				admit: (work) => admitted.admit(1, work),
				log
			});
			const answer = (response: Response | null) =>
				response === null
					? HttpServerResponse.empty({ status: 404 })
					: HttpServerResponse.fromWeb(response);
			const handle = Effect.gen(function* () {
				const incoming = yield* HttpServerRequest.HttpServerRequest;
				const address = client_address(
					Option.getOrElse(incoming.remoteAddress, () => '0.0.0.0'),
					incoming.headers['x-forwarded-for'],
					options.trustProxy
				);
				const path = new URL(incoming.url, public_url).pathname;
				const request = yield* HttpServerRequest.toWeb(incoming);
				if (path.startsWith('/hooks/integration/') || path === '/hooks/oauth/callback')
					return answer(yield* call(() => links.hook(request)));
				if (path === '/__bolt/integrations' || path.startsWith('/__bolt/integrations/')) {
					const authority = yield* call((signal) =>
						workspace.identity.authority(request.clone(), { signal })
					);
					if (authority === null)
						return json('unauthenticated', 'Sign in to manage integrations.', 401);
					return answer(yield* call(() => links.admin(request, authority)));
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
				const response = yield* guest ? admitted.admit(0, work) : work;
				if (response !== null) return HttpServerResponse.fromWeb(response);
				if (path.startsWith('/__bolt/')) return json('not_found', 'No such route.', 404);
				const page = yield* client_page(artifact.dir, path, manifest);
				return page === undefined
					? HttpServerResponse.empty({ status: 404 })
					: yield* compressAssets(HttpServerResponse.file(page.file, { headers: page.headers }));
			}).pipe(
				Effect.catch((error) => {
					const failure = wire_error(error);
					return Effect.succeed(
						HttpServerResponse.jsonUnsafe(failure.body, { status: failure.status })
					);
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
									? LIMITS.storedFileBytes
									: LIMITS.argsBytes + 1024 * 1024
							)
						)
					)
				)
			);
			yield* Effect.addFinalizer(() =>
				admitted.drain(10_000).pipe(Effect.forkChild, Effect.flatMap(Fiber.join))
			);
			const url =
				http.address._tag !== 'UnixPathAddress'
					? `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${http.address.port}`
					: public_url;
			return { url, workspace };
		})
	).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices));
