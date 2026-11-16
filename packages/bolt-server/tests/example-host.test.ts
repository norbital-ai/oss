// The example host accepts a local PGlite workspace with the optional model providers off.
import { describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { randomBytes } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { is_off } from '@norbital-ai/host-api';
import { load_host } from '@norbital-ai/host-api/node';

const example = fileURLToPath(new URL('../example/norbital.host.ts', import.meta.url));

describe('example/norbital.host.ts', () => {
	it.live('loads a copied host file outside the package into a persistent localhost workspace', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped();
			const copied = path.join(dir, 'norbital.host.ts');
			yield* fs.copyFile(example, copied);
			for (const name of ['@norbital-ai/bolt-server', '@norbital-ai/host-api', '@effect/platform-node', 'effect', 'pg']) {
				const target = path.join(dir, 'node_modules', name);
				yield* fs.makeDirectory(path.dirname(target), { recursive: true });
				symlinkSync(fileURLToPath(new URL(name === '@norbital-ai/bolt-server' ? '../' : `../node_modules/${name}`, import.meta.url)), target, 'dir');
			}
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
			// the server's own loading: the module's shape is validated and `serving.close` runs with the scope
			const { facilities } = yield* load_host(copied);
			expect(is_off(facilities.intelligence.system2)).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});
