import { expect, it } from '@effect/vitest';
import { Effect, FileSystem } from 'effect';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import * as NodePath from '@effect/platform-node/NodePath';
import { join } from 'node:path';
import { readPack } from '../src/engine/write/pack.ts';

it.effect('a malformed rows line fails the pack read as a seed decode', () =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem;
			const dir = yield* fs.makeTempDirectoryScoped();
			yield* fs.makeDirectory(join(dir, 'rows'));
			yield* fs.writeFileString(
				join(dir, 'pack.json'),
				JSON.stringify({
					format: 1,
					name: 'base',
					hash: 'hash',
					start: [],
					rows: { orders: 1 },
					assets: []
				})
			);
			yield* fs.writeFileString(join(dir, 'rows', 'orders.jsonl'), '{\n');
			expect(yield* Effect.flip(readPack(dir))).toMatchObject({ code: 'seedDecode' });
		})
	).pipe(Effect.provide(NodeFileSystem.layer), Effect.provide(NodePath.layer))
);
