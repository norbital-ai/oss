// bolt-server serves a built release through the release's own cell: a fixture workspace's kit release checkpoint, its
// Bolt the oss checkout's built package (`build/cell.js`), served over the example host file and answering a request.
import { symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Context, Effect, FileSystem, Layer, Path, Schema } from 'effect';
import { release } from '../../bolt-cli/src/test/release.ts';
import { Server, ServerLive } from '../src/server.ts';

const BOLT = fileURLToPath(new URL('../../bolt', import.meta.url));
const EXAMPLE = fileURLToPath(new URL('../example/norbital.host.ts', import.meta.url));

describe('a release served through its cell', () => {
	it.live('opens the cell, migrates and answers the shell manifest', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'bolt-server-cell-' });
			const workspace = path.join(dir, 'workspace');
			yield* fs.makeDirectory(path.join(workspace, 'src'), { recursive: true });
			yield* fs.makeDirectory(path.join(workspace, 'node_modules', '@norbital-ai'), { recursive: true });
			symlinkSync(BOLT, path.join(workspace, 'node_modules', '@norbital-ai', 'bolt'), 'dir');
			yield* fs.writeFileString(
				path.join(workspace, 'norbital.template.json'),
				JSON.stringify({
					schema_version: 1,
					key: 'norbital_cell_fixture',
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
				path.join(workspace, 'package.json'),
				JSON.stringify({ private: true, dependencies: { '@norbital-ai/bolt': 'workspace:*' } })
			);
			const built = yield* release(workspace);
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
});
