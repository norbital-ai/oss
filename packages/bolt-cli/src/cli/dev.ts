/// <reference types="node" />
// `bolt dev` untethered: the workspace's `norbital.host.ts` (or `--host=<file>`) default-exports every facility
// (`satisfies Facilities`) and optionally its `serving` parts. Each build is migrated on the host's own database and
// served through `serveRelease` on this package's `nodeGuests` runner, the path bolt-server takes: integration links,
// `activate` (whose needs check is the only gate), deadline wakes and crons. The internal SPA is served from source by a
// Vite dev server, so a page edit is a hot update; a model edit rebuilds the manifest and guest only.
import { Effect, FileSystem, Option, Path, Scope, ScopedRef } from 'effect';
import { HttpServerRequest, HttpServerResponse } from 'effect/http';
import * as NodeHttpServer from '@effect/platform-node/NodeHttpServer';
import { createServer } from 'node:http';
import { nodeGuests } from '../guests.ts';
import { clientDevServer } from '../compiler/artifact/client.ts';
import {
	artifactPort,
	call,
	loadHost,
	serveRelease,
	nodePorts,
	responseError
} from '@norbital-ai/bolt/tooling';
import { HOST_API } from '@norbital-ai/bolt/host-api';
import { clientPage } from '@norbital-ai/bolt/engine';
import { buildWorkspace, ToolFailure, watchWorkspace, type Built, type Log } from './build.ts';

/**
 * `bolt dev` tethered (no host file), the process `env start` runs per template: the realm's watcher hands each build to
 * the callback this returns. The internal SPA is served from source by a Vite dev server on loopback under
 * `/__bolt/dev/<directory>/`, recorded in `.norbital/dev.json` with the build it serves (`artifact`). Local Colony
 * serves that build's document from it and proxies its modules and hot-update socket to it, so a page or component
 * edit is a hot update in the open tab; the bundle's client is kept (`spaServed`), so its digest does not move. Any
 * other edit is a new digest Colony cuts over to. The record is removed when the process ends.
 */
export const tethered = Effect.fn('bolt.tethered')(function* (root: string, log: Log) {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path,
		scope = yield* Effect.scope;
	const base = `/__bolt/dev/${path.basename(root)}/`,
		record = path.join(root, '.norbital', 'dev.json');
	let client: Effect.Success<ReturnType<typeof clientDevServer>> | undefined;
	const server = createServer((request, response) => {
		if (client === undefined) return response.writeHead(503).end();
		if (request.url === base)
			return response
				.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
				.end(client.document);
		client.middlewares(request, response, () => response.writeHead(404).end());
	});
	yield* Effect.acquireRelease(
		Effect.callback<void, ToolFailure>((resume) => {
			server.once('error', (cause) =>
				resume(
					Effect.fail(new ToolFailure({ message: 'The page dev server could not listen.', cause }))
				)
			);
			server.listen(0, '127.0.0.1', () => resume(Effect.void));
		}),
		() =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections();
				server.close(() => resume(Effect.void));
			})
	);
	const address = server.address();
	const origin = `http://127.0.0.1:${address !== null && typeof address === 'object' ? address.port : 0}`;
	yield* Effect.addFinalizer(() => fs.remove(record, { force: true }).pipe(Effect.ignore));
	return (built: Built) =>
		Effect.gen(function* () {
			const manifest = built.artifact.manifest;
			if (client === undefined)
				client = yield* clientDevServer(
					root,
					built.files,
					manifest,
					path.join(built.artifact.dir, 'client'),
					built.artifact.artifact.name,
					server,
					base
				);
			else yield* client.refresh(built.files, manifest);
			// replaced whole: Colony never reads half a record
			yield* fs.writeFileString(
				`${record}.next`,
				JSON.stringify({ origin, base, artifact: built.artifact.artifact.hash })
			);
			yield* fs.rename(`${record}.next`, record);
		}).pipe(
			Effect.catch((error) => Effect.sync(() => log(String(error)))),
			Effect.provideService(Scope.Scope, scope),
			Effect.provideService(FileSystem.FileSystem, fs),
			Effect.provideService(Path.Path, path)
		);
});

export const dev = Effect.fn('bolt.dev')(function* (
	root: string,
	hostFile: string,
	options: { readonly port: number; readonly log: Log }
) {
	const path = yield* Path.Path;
	const { facilities, serving } = yield* loadHost(hostFile);
	const publicUrl = `http://127.0.0.1:${options.port}`;
	const native = yield* nodePorts();
	const guests = nodeGuests();
	const watching = {
		log: options.log,
		spaServed: true
	};
	/** One build, migrated on the host's database and served; closed when the next one replaces it. */
	const activated = (built: Built) =>
		Effect.gen(function* () {
			const release = {
				id: built.artifact.artifact.hash,
				artifact: artifactPort(built.artifact.dir)
			};
			const branch = yield* call((signal) =>
				HOST_API.branch(
					{ release, database: facilities.storage.database, audit: facilities.logs.audit },
					{ signal }
				)
			);
			yield* call((signal) => branch.schema.migrate({ signal }));
			const served = yield* serveRelease({
				scope: 'dev',
				release,
				publicUrl,
				facilities,
				serving,
				// the untethered loop runs guest code as bolt-server does: `node:vm` contexts in this process
				guests,
				native,
				workspace: { name: built.artifact.artifact.name, handle: built.artifact.artifact.handle },
				admit: (work) => work,
				log: options.log
			});
			return { ...served, built };
		}).pipe(
			Effect.mapError(
				(cause) => new ToolFailure({ message: 'The build could not be activated.', cause })
			)
		);
	const first = yield* buildWorkspace(root, watching);
	const active = yield* ScopedRef.fromAcquire(activated(first));
	const server = createServer();
	const client = yield* clientDevServer(
		root,
		first.files,
		first.artifact.manifest,
		path.join(first.artifact.dir, 'client'),
		first.artifact.artifact.name,
		server,
		'/'
	);
	// Bolt's routes first, then the release's own files (brand icons, public page entries); a document is the SPA's
	const app = Effect.gen(function* () {
		const incoming = yield* HttpServerRequest.HttpServerRequest;
		const request = yield* HttpServerRequest.toWeb(incoming);
		const address = Option.getOrElse(incoming.remoteAddress, () => '127.0.0.1');
		const { workspace, links, built } = yield* ScopedRef.get(active);
		const pathname = new URL(incoming.url, publicUrl).pathname;
		const response = yield* pathname.startsWith('/hooks/integration/') ||
		pathname === '/hooks/oauth/callback'
			? call(() => links.hook(request))
			: pathname === '/__bolt/integrations' || pathname.startsWith('/__bolt/integrations/')
				? call(async (signal) => {
						const authority = await workspace.identity.authority(request.clone(), { signal });
						return authority === null
							? Response.json(
									{
										error: { code: 'unauthenticated', message: 'Sign in to manage integrations.' }
									},
									{ status: 401 }
								)
							: links.admin(request, authority);
					})
				: call(
						async (signal) =>
							(await workspace.handle(request, { address })) ??
							(await workspace.render(request, { address, signal }))
					);
		if (response !== null) return HttpServerResponse.fromWeb(response);
		const page = yield* clientPage(built.artifact.dir, pathname, built.artifact.manifest);
		if (page === undefined) return HttpServerResponse.empty({ status: 404 });
		return page.document
			? HttpServerResponse.text(client.document, { headers: page.headers })
			: yield* HttpServerResponse.file(page.file, { headers: page.headers });
	}).pipe(Effect.catch((error) => Effect.succeed(responseError(error))));
	const bolt = yield* NodeHttpServer.makeHandler(app, { scope: yield* Effect.scope }).pipe(
		Effect.provide(NodeHttpServer.layerHttpServices)
	);
	// Vite answers its own module, asset and hot-update requests; everything else is Bolt's
	server.on('request', (request, response) =>
		client.middlewares(request, response, () => bolt(request, response))
	);
	yield* Effect.acquireRelease(
		Effect.callback<void, ToolFailure>((resume) => {
			server.once('error', (cause) =>
				resume(
					Effect.fail(new ToolFailure({ message: `Port ${options.port} is unavailable.`, cause }))
				)
			);
			server.listen(options.port, '127.0.0.1', () => resume(Effect.void));
		}),
		() =>
			Effect.callback<void>((resume) => {
				server.closeAllConnections();
				server.close(() => resume(Effect.void));
			})
	);
	options.log(`dev ready (untethered, ${hostFile}): ${publicUrl}`);
	const io = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
	yield* watchWorkspace(
		root,
		watching,
		(next) =>
			client.refresh(next.files, next.artifact.manifest).pipe(
				Effect.andThen(ScopedRef.set(active, activated(next))),
				Effect.tap(() => Effect.sync(() => options.log('reloaded'))),
				Effect.catch((error) => Effect.sync(() => options.log(String(error)))),
				Effect.provide(io)
			),
		first
	).pipe(Effect.forkScoped);
});
