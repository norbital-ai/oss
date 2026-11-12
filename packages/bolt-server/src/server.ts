// One Bolt workspace artifact served from one process with its host file (`norbital.host.ts`), through `serve`
// (`@norbital-ai/bolt/node`): the release's routes over the engine path `bolt dev --host` takes. This process owns
// admission, the static pages and the HTTP listener around it.
import { ByteSize, Context, Effect, Fiber, Layer, Option } from 'effect';
import { HttpServerRequest, HttpServerResponse, HttpIncomingMessage, HttpMiddleware } from 'effect/http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { createServer } from 'node:http';
import { client_address, LIMITS, wire_error } from '@norbital-ai/bolt/engine';
import { client_page } from '@norbital-ai/bolt/protocol';
import type { HostApi } from '@norbital-ai/bolt/host-api';
import { serve } from '@norbital-ai/bolt/node';
import { node_guests } from '@norbital-ai/bolt-cli/guests';
import { envelope } from './envelope.ts';

export type ServeOptions = {
	/** The workspace directory: its `norbital.host.ts` serves it unless `hostFile` names another. */
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

export class Server extends Context.Service<
	Server,
	{
		readonly url: string;
		readonly workspace: Awaited<ReturnType<HostApi['activate']>>;
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
			const listening = `http://${options.host.includes(':') ? `[${options.host}]` : options.host}:${options.port}`;
			const admitted = yield* envelope(options.maxConcurrent ?? 8);
			const { workspace, artifact, public_url, handle: route } = yield* serve({
				workspace: options.workspace,
				host_file: options.hostFile,
				artifact: options.artifact,
				listening,
				// this host's own guest runner, never the host file's: `node:vm` contexts for operator-trusted code
				guests: node_guests(),
				seed: options.seed,
				founder: options.founder,
				admit: admitted.admit,
				log
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
				const page = yield* client_page(artifact.dir, path, artifact.manifest);
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
