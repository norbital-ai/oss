import { assert, it } from '@effect/vitest';
import { Effect, FileSystem, Result } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { join } from 'node:path';
import { readPack } from '../src/engine/write/pack.ts';

it.effect('a failed row decode releases its seed-pack file', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped();
			yield* fs.makeDirectory(join(dir, 'rows'));
			yield* fs.writeFileString(
				join(dir, 'pack.json'),
				JSON.stringify({
					format: 1,
					name: 'sample',
					hash: 'hash',
					start: [],
					rows: { orders: 1 },
					assets: []
				})
			);
			yield* fs.writeFileString(join(dir, 'rows', 'orders.jsonl'), '{\n');
			let released = 0;
			const watched: FileSystem.FileSystem = {
				...fs,
				open: (path, options) =>
					fs.open(path, options).pipe(
						Effect.tap(() =>
							Effect.addFinalizer(() =>
								Effect.sync(() => {
									released++;
								})
							)
						)
					)
			};
			const result = yield* Effect.result(
				readPack(dir).pipe(Effect.provideService(FileSystem.FileSystem, watched))
			);
			assert.isTrue(Result.isFailure(result));
			assert.strictEqual(released, 1);
		})
	).pipe(Effect.provide(NodeFileSystem.layer))
);
