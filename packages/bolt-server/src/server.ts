import { Context, Effect, Fiber, FileSystem, Layer, Option, Path } from 'effect';
import {
	FetchHttpClient,
	HttpServerRequest,
	HttpServerResponse,
	HttpIncomingMessage
} from 'effect/unstable/http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { createServer } from 'node:http';
import pg from 'pg';
import {
	BoltError,
	IdentityRefusal,
	CODE,
	BoltHost,
	Live,
	PublicPages,
	TenantDb,
	clientAddress,
	clientPage,
	needsGuest,
	renderMode,
	LIMITS,
	wireError
} from '@norbital-ai/bolt/engine';
import { PgliteDb, PostgresDb } from '@norbital-ai/bolt/node';
import type { Config } from './config.ts';
import { activate, prepare, type StartOptions } from './activate.ts';
import { ops } from './routes.ts';
export type { StartOptions } from './activate.ts';

export const pgOptions = (url: string) => ({
	connectionString: url,
	...(new URL(url).searchParams.has('sslmode') ? {} : { ssl: true }),
	max: 10
});
export const DatabaseLive = (config: Config) => {
	const database = config.database;
	return 'pglite' in database
		? PgliteDb.layer(database.pglite)
		: Layer.unwrap(
				Effect.gen(function* () {
					const pool = yield* Effect.acquireRelease(
						Effect.sync(() => new pg.Pool(pgOptions(database.url))),
						(pool) =>
							Effect.tryPromise({
								try: () => pool.end(),
								catch: (cause) =>
									BoltError.make(
										'upstream',
										'facility',
										'The database pool could not close.',
										cause
									)
							}).pipe(Effect.tapCause(Effect.logWarning), Effect.ignore)
					);
					pool.on('error', (cause) => console.error('[bolt] database pool error', cause));
					return PostgresDb.layer(pool);
				})
			);
};
export class Server extends Context.Service<
	Server,
	{
		readonly url: string;
		readonly warnings: readonly string[];
		readonly context: Effect.Success<ReturnType<typeof activate>>['context'];
	}
>()('bolt-server/Server') {}
/** The process scope owns admission, activation, database, provider links and the HTTP listener. */
export const ServerLive = (config: Config, options: StartOptions = {}) =>
	Layer.unwrap(
		Effect.gen(function* () {
			const prepared = yield* prepare(config, options);
			return Layer.effect(
				Server,
				Effect.gen(function* () {
					const activation = yield* activate(config, prepared, options),
						host = Context.get(activation.context, BoltHost),
						pages = Context.get(activation.context, PublicPages);
					const io =
						yield* Effect.context<import('effect/unstable/http/HttpPlatform').HttpPlatform>();
					const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
					const handle = Effect.gen(function* () {
						const incoming = yield* HttpServerRequest.HttpServerRequest;
						const address = clientAddress(
							Option.getOrElse(incoming.remoteAddress, () => '0.0.0.0'),
							incoming.headers['x-forwarded-for'],
							config.trustProxy
						);
						const request = incoming.modify({ remoteAddress: Option.some(address) }),
							path = new URL(request.url, config.publicUrl).pathname;
						if (path === '/__bolt/ops')
							return yield* ops(config, activation.artifact.artifact.handle, request).pipe(
								Effect.provide(activation.context)
							);
						const work = Effect.gen(function* () {
							const response = yield* host.handle(request);
							return Option.isSome(response) ? response : yield* pages.render(request);
						});
						const guest =
							((request.method === 'GET' || request.method === 'HEAD') &&
								renderMode(activation.artifact.manifest, path) !== null) ||
							(yield* needsGuest(request).pipe(Effect.catch(() => Effect.succeed(true))));
						const response = yield* guest ? activation.envelope.admit(0, work) : work;
						if (Option.isSome(response)) return response.value;
						if (path.startsWith('/__bolt/'))
							return HttpServerResponse.jsonUnsafe(
								{ error: { code: 'notFound', message: 'No such route.' } },
								{ status: 404 }
							);
						const page = yield* clientPage(
							activation.artifact.dir,
							path,
							activation.artifact.manifest
						).pipe(Effect.provide(files));
						return page === undefined
							? HttpServerResponse.empty({ status: 404 })
							: yield* HttpServerResponse.file(page.file, { headers: page.headers }).pipe(
									Effect.provide(io)
								);
					}).pipe(
						Effect.catch((error) => {
							const answer =
								error instanceof IdentityRefusal
									? {
											body: { error: { code: error.code, message: error.message } },
											status: CODE[error.code].status
										}
									: wireError(error);
							return Effect.succeed(
								HttpServerResponse.jsonUnsafe(answer.body, { status: answer.status })
							);
						}),
						Effect.catchCause((cause) =>
							Effect.logWarning(cause).pipe(
								Effect.as(
									HttpServerResponse.jsonUnsafe(
										{ error: { code: 'internal', message: 'The request failed.' } },
										{ status: 500 }
									)
								)
							)
						)
					);
					const http = yield* NodeHttpServer.make(() => createServer(), {
						host: config.host,
						port: config.port,
						gracefulShutdownTimeout: '10 seconds'
					});
					yield* http.serve(
						Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
							handle.pipe(
								Effect.provideService(
									HttpIncomingMessage.MaxBodySize,
									FileSystem.Size(
										new URL(request.url, config.publicUrl).pathname.startsWith('/__bolt/files/')
											? LIMITS.storedFileBytes
											: LIMITS.argsBytes + 1024 * 1024
									)
								)
							)
						)
					);
					yield* Effect.addFinalizer(() =>
						Effect.gen(function* () {
							const draining = yield* activation.envelope.drain(10_000).pipe(Effect.forkChild);
							yield* Context.get(activation.context, Live).close(activation.artifact.artifact.hash);
							yield* Fiber.join(draining);
						})
					);
					const url =
						http.address._tag === 'TcpAddress'
							? `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${http.address.port}`
							: config.publicUrl;
					return {
						url,
						warnings: activation.warnings,
						context: activation.context
					};
				})
			).pipe(Layer.provideMerge(DatabaseLive(config)));
		})
	).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, NodeHttpServer.layerHttpServices))
	);
