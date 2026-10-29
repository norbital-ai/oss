// `loadHost`: a host file that throws while loading names its own failure, not a missing default export.
import { describe, expect, it } from '@effect/vitest';
import * as NodeServices from '@effect/platform-node/NodeServices';
import { Effect, Exit, FileSystem, Path } from 'effect';
import { loadHost } from '../src/node/host.ts';

describe('loadHost', () => {
	it.live('reports why a host file failed to load, and a missing default export as such', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem,
				path = yield* Path.Path;
			const dir = yield* fs.makeTempDirectoryScoped();
			const throwing = path.join(dir, 'throwing.host.mjs'),
				empty = path.join(dir, 'empty.host.mjs');
			yield* fs.writeFileString(throwing, "throw new Error('BOLT_X is required');\n");
			yield* fs.writeFileString(empty, 'export default {};\n');
			const failure = (file: string) =>
				loadHost(file).pipe(
					Effect.scoped,
					Effect.exit,
					Effect.map((exit) => (Exit.isFailure(exit) ? String(exit.cause) : 'loaded'))
				);
			const thrown = yield* failure(throwing);
			expect(thrown).toContain('could not load: BOLT_X is required');
			expect(thrown).not.toContain('must default-export');
			expect(yield* failure(empty)).toContain('must default-export its Facilities');
		}).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
	);
});
