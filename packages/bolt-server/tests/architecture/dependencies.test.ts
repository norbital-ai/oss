import { assert, it } from '@effect/vitest';
import { Effect } from 'effect';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '../../src');
const forbidden = [
	'@norbital-ai/bolt',
	'@norbital-ai/colony',
	'@norbital-ai/core',
	'@norbital-ai/pod',
	'@norbital-ai/platform-utils'
];

it.effect('imports only neutral protocol and physical-provider dependencies', () =>
	Effect.gen(function* () {
		const entries = yield* Effect.tryPromise(() =>
			readdir(sourceRoot, { recursive: true, withFileTypes: true })
		);
		const files = entries
			.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
			.map((entry) => join(entry.parentPath, entry.name));
		const sources = yield* Effect.tryPromise(() =>
			Promise.all(files.map((file) => readFile(file, 'utf8')))
		);
		for (const dependency of forbidden) {
			assert.isFalse(sources.some((source) => source.includes(`from '${dependency}'`)));
		}
	})
);
