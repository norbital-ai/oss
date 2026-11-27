// bolt-server serves a built release through the release's own cell: a fixture workspace's kit release checkpoint, its
// Bolt the oss checkout's built package (`build/cell.js`). The cell passes the host-api conformance kit over this host's
// own adapters (its `vm_cell`, PGlite and keys), serves the shell manifest over the example host file, and a cell
// speaking another HOST_API, above or below this host's, is refused.
import { symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Context, Effect, FiberSet, FileSystem, Layer, Path, Schema, Scope } from 'effect';
import { conformance, HOST_API_VERSION } from '@norbital-ai/host-api';
import {
	artifact_port,
	keys_port,
	PgliteDb,
	Pristine,
	tenant_db_port,
	vm_cell
} from '@norbital-ai/host-api/node';
import { release } from '../../bolt-cli/src/test/release.ts';
import { Server, ServerLive } from '../src/server.ts';

const BOLT = fileURLToPath(new URL('../../bolt', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../example/norbital.host.ts', import.meta.url));

/** A workspace over the oss checkout's Bolt with one HTTP integration (the instance the kit administers), built. */
const fixture = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem,
		path = yield* Path.Path;
	const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-server-cell-' });
	const workspace = path.join(dir, 'workspace');
	yield* fs.makeDirectory(path.join(workspace, 'src', 'integration', 'erp'), { recursive: true });
	yield* fs.makeDirectory(path.join(workspace, 'node_modules', '@norbital-ai'), { recursive: true });
	symlinkSync(BOLT, path.join(workspace, 'node_modules', '@norbital-ai', 'bolt'), 'dir');
	yield* fs.writeFileString(
		path.join(workspace, 'norbital.template.json'),
		JSON.stringify({
			schema_version: 1,
			key: 'norbital-cell-fixture',
			name: 'Cell fixture',
			industry: 'Operations',
			description: 'A workspace served through its cell',
			visibility: 'public',
			counts: { models: 0, apps: 0, automations: 0 },
			tags: []
		})
	);
	yield* fs.writeFileString(
		path.join(workspace, 'src', '+workspace.ts'),
		"import { workspace } from '@norbital-ai/bolt';\nexport default workspace({ tz: 'UTC', locale: 'en' });\n"
	);
	yield* fs.writeFileString(
		path.join(workspace, 'src', 'integration', 'erp', '+integration.ts'),
		`import { integration } from '@norbital-ai/bolt';
export default integration('erp', {
	description: 'The ERP.',
	driver: 'http',
	credential: { secret: { kind: 'text' } },
	http: { base_url: 'https://erp.example/api', auth: { header: { name: 'x-api-key', value: 'secret' } } }
});
`
	);
	yield* fs.writeFileString(
		path.join(workspace, 'package.json'),
		JSON.stringify({ private: true, dependencies: { '@norbital-ai/bolt': 'workspace:*' } })
	);
	return { dir, workspace, built: yield* release(workspace) };
});

/** The example host file's settings for a local host under `dir`, the process env restored when the scope closes. */
const hostEnv = (dir: string) =>
	Effect.gen(function* () {
		const path = yield* Path.Path;
		const saved = { ...process.env };
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				process.env = saved;
			})
		);
		Object.assign(process.env, {
			BOLT_PUBLIC_URL: 'http://localhost:3100',
			BOLT_PGLITE_DIR: path.join(dir, 'db'),
			BOLT_AUDIT_DIR: path.join(dir, 'audit'),
			BOLT_MASTER_KEY: randomBytes(32).toString('hex'),
			BOLT_FILES_PROVIDER: 'local',
			BOLT_FILES_ENDPOINT: path.join(dir, 'files'),
			BOLT_TRANSACTIONAL_EMAIL: 'log'
		});
	});

/** `cell` (a release's `build/cell.js`) whose `open` answers HOST_API `version`: the same release on another protocol. */
const speaking = (cell: string, version: number) => `${cell}
;(() => {
	const cell = globalThis.__bolt_cell;
	Object.defineProperty(globalThis, '__bolt_cell', {
		value: { ...cell, open: (kernel) => {
			const end = cell.open(kernel);
			return { ...end, api: { ...end.api, fields: { ...end.api.fields, version: ${version} } } };
		} },
		configurable: true
	});
})();
`;

describe('a release served through its cell', () => {
	it.live(
		"passes the host-api conformance kit over this host's cell, PGlite databases and keys",
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem,
					path = yield* Path.Path;
				const { dir, built } = yield* fixture;
				const bundle = path.join(built, 'bundle'),
					tampered = path.join(dir, 'tampered'),
					docs = path.join(BOLT, 'build', 'docs');
				yield* fs.copy(bundle, tampered);
				yield* fs.writeFileString(path.join(tampered, 'guest.mjs'), '// changed after the build\n', {
					flag: 'a'
				});
				const cell = yield* Effect.acquireRelease(
					fs
						.readFileString(path.join(BOLT, 'build', 'cell.js'))
						.pipe(Effect.map((source) => vm_cell(source, () => {}))),
					(cell) => Effect.sync(() => cell.close())
				);
				const scope = yield* Scope.Scope;
				const run = yield* FiberSet.makeRuntimePromise<Pristine>();
				for (const check of conformance({
					api: cell.api,
					release: { id: 'kit', artifact: artifact_port(bundle, docs) },
					tampered: { id: 'kit-tampered', artifact: artifact_port(tampered, docs) },
					branches: {
						// the example host's tenant database: a PGlite over host-api's adapter, as the Host API port
						database: () =>
							run(
								PgliteDb.open().pipe(
									Scope.provide(scope),
									Effect.map((client) => {
										const raw = PgliteDb.make(client);
										return { raw, port: tenant_db_port(raw) };
									})
								)
							),
						keys: keys_port(randomBytes(32)),
						instance: { integration: 'erp', configuration: {} }
					}
				}))
					yield* Effect.tryPromise({
						try: check.run,
						catch: (cause) => new Error(`${check.name}: ${String(cause)}`)
					});
			}).pipe(Effect.scoped, Effect.provide([NodeServices.layer, Pristine.layer]))
	);

	it.live('opens the cell, migrates and answers the shell manifest', () =>
		Effect.gen(function* () {
			const path = yield* Path.Path;
			const { dir, workspace, built } = yield* fixture;
			yield* hostEnv(dir);
			const server = Context.get(
				yield* Layer.build(
					ServerLive({
						workspace,
						artifact: path.join(built, 'bundle'),
						hostFile: EXAMPLE,
						host: '127.0.0.1',
						port: 0,
						trustProxy: [],
						log: () => {}
					})
				),
				Server
			);
			const response = yield* Effect.promise(() => fetch(`${server.url}/manifest.webmanifest`));
			expect(response.status).toBe(200);
			const manifest = Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(
				yield* Effect.promise(() => response.json())
			);
			expect(manifest.name).toBe('Cell fixture');
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);

	it.live('refuses a release whose cell speaks another HOST_API, above or below its own', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const { dir, built } = yield* fixture;
			const cell = yield* fs.readFileString(path.join(BOLT, 'build', 'cell.js'));
			for (const version of [HOST_API_VERSION + 1, HOST_API_VERSION - 1]) {
				const workspace = path.join(dir, `speaks-${version}`),
					bolt = path.join(workspace, 'node_modules', '@norbital-ai', 'bolt', 'build');
				yield* fs.makeDirectory(bolt, { recursive: true });
				yield* fs.writeFileString(path.join(bolt, 'cell.js'), speaking(cell, version));
				// the host file at a path of its own: a module loaded and closed by another server is not served again
				yield* fs.copyFile(EXAMPLE, path.join(workspace, 'norbital.host.ts'));
				for (const name of [
					'@norbital-ai/bolt-server',
					'@norbital-ai/host-api',
					'@effect/platform-node',
					'effect',
					'pg'
				]) {
					const target = path.join(workspace, 'node_modules', name);
					yield* fs.makeDirectory(path.dirname(target), { recursive: true });
					symlinkSync(
						fileURLToPath(
							new URL(
								name === '@norbital-ai/bolt-server' ? '../' : `../node_modules/${name}`,
								import.meta.url
							)
						),
						target,
						'dir'
					);
				}
				yield* hostEnv(workspace);
				const refusal = yield* Effect.flip(
					Layer.build(
						ServerLive({
							workspace,
							artifact: path.join(built, 'bundle'),
							host: '127.0.0.1',
							port: 0,
							trustProxy: [],
							log: () => {}
						})
					)
				);
				expect(refusal).toMatchObject({
					_tag: 'ServerError',
					code: 'invalid_spec',
					message: `The release speaks HOST_API ${version}; this server serves HOST_API ${HOST_API_VERSION}`
				});
			}
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});
