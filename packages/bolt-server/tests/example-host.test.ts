// The example host accepts a local PGlite workspace with the optional model providers off.
import { describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, FileSystem, Path } from 'effect';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { is_off } from '@norbital-ai/host-api';
import { load_host } from '@norbital-ai/host-api/node';

const example = fileURLToPath(new URL('../example/norbital.host.ts', import.meta.url));

describe('example/norbital.host.ts', () => {
	it.live('loads a persistent localhost workspace', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped();
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
			const { facilities } = yield* load_host(example);
			expect(is_off(facilities.intelligence.system2)).toBe(true);
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});
