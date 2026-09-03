import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const testsRoot = new URL('.', import.meta.url).pathname;

// This file names both markers in order to look for them, which would otherwise make it the one
// database-backed test that isn't. A rule cannot be its own subject.
const ruleFile = 'architecture-test-suite-split.test.ts';

const testFiles = async (root: string): Promise<ReadonlyArray<string>> => {
	const entries = await readdir(root, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) =>
			entry.isDirectory()
				? testFiles(join(root, entry.name))
				: Promise.resolve(entry.name.endsWith('.test.ts') ? [join(root, entry.name)] : [])
		)
	);
	return nested.flat();
};

/**
 * A file reaches a database either by importing PGlite itself or by taking the shared test layer
 * that boots one. Both are visible in the file's own text, so this check needs no module graph.
 */
const bootsADatabase = (source: string): boolean =>
	source.includes('@electric-sql/pglite') || source.includes('bolt-test-layer');

describe('test suite split', () => {
	// `vitest.config.ts` selects suites by filename, so the filename is the only thing standing
	// between a database-backed test and the merge path. A file that boots a Postgres without the
	// suffix does not fail — it silently rejoins the unit suite and puts its twenty seconds back in
	// front of every push.
	it('names every database-backed test as an integration test', async () => {
		const files = await testFiles(testsRoot);
		const misfiled = await Promise.all(
			files
				.filter(
					(file) => !file.endsWith('.integration.test.ts') && !file.endsWith(ruleFile)
				)
				.map(async (file) => ({ file, boots: bootsADatabase(await readFile(file, 'utf8')) }))
		);
		expect(
			misfiled.filter(({ boots }) => boots).map(({ file }) => file.slice(testsRoot.length))
		).toEqual([]);
	});

	// The converse. An integration file that boots nothing pays the integration suite's scheduling
	// for no reason, and worse, stops running on the merge path that could have gated it.
	it('keeps the integration suite to tests that need a database', async () => {
		const files = await testFiles(testsRoot);
		const idle = await Promise.all(
			files
				.filter((file) => file.endsWith('.integration.test.ts'))
				.map(async (file) => ({ file, boots: bootsADatabase(await readFile(file, 'utf8')) }))
		);
		expect(
			idle.filter(({ boots }) => !boots).map(({ file }) => file.slice(testsRoot.length))
		).toEqual([]);
	});
});
