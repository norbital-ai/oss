import assert from 'node:assert/strict';
import path from 'node:path';
import { layer } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import { copyWorkspace } from '../validate-package-publication.ts';
import { ScriptLive } from '../runtime.ts';
layer(ScriptLive, { excludeTestServices: true })('publication workspace', (it) => {
	it.effect('excludes generated trees and preserves links without traversing their targets', () =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const root = yield* fs.makeTempDirectoryScoped({ prefix: 'norbital-publication-copy-' });
			const source = path.join(root, 'source');
			const output = path.join(root, 'output');
			const external = path.join(root, 'external');
			for (const directory of [
				source,
				external,
				path.join(source, 'node_modules'),
				path.join(source, 'build.staging-test')
			])
				yield* fs.makeDirectory(directory, { recursive: true });
			yield* fs.writeFileString(path.join(source, 'package.json'), '{}');
			yield* fs.writeFileString(path.join(external, 'private.txt'), 'external');
			yield* fs.symlink(external, path.join(source, 'linked'));
			yield* copyWorkspace(source, output);
			assert.equal(yield* fs.exists(path.join(output, 'package.json')), true);
			assert.equal(yield* fs.exists(path.join(output, 'node_modules')), false);
			assert.equal(yield* fs.exists(path.join(output, 'build.staging-test')), false);
			assert.equal(yield* fs.readLink(path.join(output, 'linked')), external);
		})
	);
});
