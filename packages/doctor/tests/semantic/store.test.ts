/**
 * Index storage: roundtrip, incremental reuse, invalidation, corruption, atomicity.
 *
 * A fake embedder records every call so "unchanged files were not re-embedded" is a fact about
 * calls, not timings. The atomicity test plants a *directory* at the exact tmp path the writer
 * will use (`<target>.<pid>.tmp`, same convention as the evidence writer), which makes the
 * tmp-phase write fail with EISDIR before any rename can fire — the portable way to simulate a
 * mid-write crash without root or fault injection hooks. The committed state must come through
 * byte-identical.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Embedder, EmbedKind, UsageReportingEmbedder } from '../../build/semantic/embedder.js';
import { readIndex, refreshIndex } from '../../build/semantic/store.js';

const vectorFor = (text: string, dimensions: number): Float32Array => {
	const digest = createHash('sha256').update(text).digest();
	return new Float32Array(
		Array.from({ length: dimensions }, (_, index) => ((digest[index % 32] ?? 0) / 255) * 2 - 1)
	);
};

type FakeEmbedder = {
	embedder: Embedder;
	calls: Array<{ texts: ReadonlyArray<string>; kind: EmbedKind }>;
};

const fakeEmbedder = (id = 'fake:test-model:4', dimensions = 4): FakeEmbedder => {
	const calls: Array<{ texts: ReadonlyArray<string>; kind: EmbedKind }> = [];
	return {
		embedder: {
			id,
			dimensions,
			embed: async (texts, kind) => {
				calls.push({ texts: [...texts], kind });
				return texts.map((text) => vectorFor(text, dimensions));
			}
		},
		calls
	};
};

const fakeUsageEmbedder = (
	id: string,
	dimensions: number,
	state: { requests: number; tokens: number }
): UsageReportingEmbedder => ({
	id,
	dimensions,
	embed: async (texts) => {
		state.requests += texts.length;
		state.tokens += texts.length * 10;
		return texts.map((text) => vectorFor(text, dimensions));
	},
	usage: () => ({ apiRequests: state.requests, promptTokens: state.tokens, costUsd: undefined })
});

const fixtureFiles = (): Map<string, { hash: string; text: string }> => {
	const entries: Array<[string, string]> = [
		['src/alpha.ts', 'export const alpha = 1;'],
		['src/beta.ts', 'export const beta = 2;'],
		['lib/gamma.ts', 'export const gamma = 3;']
	];
	return new Map(
		entries.map(([path, text]) => [
			path,
			{ hash: createHash('sha256').update(text).digest('hex'), text }
		])
	);
};

const workspace = (context: { after: (fn: () => void) => void }): string => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-index-'));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	return join(root, '.norbital', 'diagnosis', 'index');
};

test('an absent index directory reads as undefined', (context) => {
	assert.equal(readIndex(workspace(context)), undefined);
});

test('a first refresh embeds everything and writes all three artifacts', async (context) => {
	const directory = workspace(context);
	const fake = fakeEmbedder();
	const result = await refreshIndex({ directory, embedder: fake.embedder, files: fixtureFiles() });

	assert.equal(result.stats.filesTotal, 3);
	assert.equal(result.stats.filesEmbedded, 3);
	assert.equal(result.stats.filesUnchanged, 0);
	assert.equal(result.stats.filesDeleted, 0);
	assert.equal(fake.calls.length, 1);
	assert.deepEqual(fake.calls[0]?.kind, 'document');
	assert.equal(typeof result.stats.durationMs, 'number');

	const snapshot = readIndex(directory);
	assert.notEqual(snapshot, undefined);
	assert.equal(snapshot?.embedderId, 'fake:test-model:4');
	assert.equal(snapshot?.dimensions, 4);
	assert.equal(snapshot?.merkleRoot, result.root);
	assert.deepEqual([...(snapshot?.entries.keys() ?? [])].sort(), [
		'lib/gamma.ts',
		'src/alpha.ts',
		'src/beta.ts'
	]);
	for (const [path, vector] of result.vectors)
		assert.deepEqual([...vector], [...vectorFor(fixtureFiles().get(path)?.text ?? '', 4)]);
	assert.ok(existsSync(join(directory, 'vectors.bin')));
});

test('an unchanged refresh reuses every vector and rewrites identical bytes', async (context) => {
	const directory = workspace(context);
	const first = fakeEmbedder();
	await refreshIndex({ directory, embedder: first.embedder, files: fixtureFiles() });
	const vectorsBefore = readFileSync(join(directory, 'vectors.bin'));
	const entriesBefore = readFileSync(join(directory, 'entries.jsonl'));

	const second = fakeEmbedder();
	const result = await refreshIndex({ directory, embedder: second.embedder, files: fixtureFiles() });

	assert.equal(second.calls.length, 0);
	assert.equal(result.stats.filesEmbedded, 0);
	assert.equal(result.stats.filesUnchanged, 3);
	assert.equal(readFileSync(join(directory, 'vectors.bin')).equals(vectorsBefore), true);
	assert.equal(
		readFileSync(join(directory, 'entries.jsonl'), 'utf8'),
		entriesBefore.toString()
	);
});

test('changed files re-embed, deleted files drop out', async (context) => {
	const directory = workspace(context);
	const first = fakeEmbedder();
	await refreshIndex({ directory, embedder: first.embedder, files: fixtureFiles() });

	const mutated = fixtureFiles();
	mutated.set('src/beta.ts', { hash: createHash('sha256').update('rewritten').digest('hex'), text: 'rewritten' });
	mutated.delete('lib/gamma.ts');
	const second = fakeEmbedder();
	const result = await refreshIndex({ directory, embedder: second.embedder, files: mutated });

	assert.equal(result.stats.filesEmbedded, 1);
	// Only alpha is present-and-unchanged; beta re-embeds and gamma's absence is a deletion.
	assert.equal(result.stats.filesUnchanged, 1);
	assert.equal(result.stats.filesDeleted, 1);
	assert.deepEqual(second.calls[0]?.texts, ['rewritten']);
	assert.equal(result.vectors.has('lib/gamma.ts'), false);

	const snapshot = readIndex(directory);
	assert.deepEqual([...(snapshot?.entries.keys() ?? [])].sort(), ['src/alpha.ts', 'src/beta.ts']);
});

test('a changed embedder id invalidates the whole index', async (context) => {
	const directory = workspace(context);
	const first = fakeEmbedder('fake:model-a:4');
	await refreshIndex({ directory, embedder: first.embedder, files: fixtureFiles() });
	const second = fakeEmbedder('fake:model-b:4');
	const result = await refreshIndex({ directory, embedder: second.embedder, files: fixtureFiles() });
	assert.equal(result.stats.filesEmbedded, 3);
	assert.equal(result.stats.filesUnchanged, 0);
	assert.equal(second.calls.length, 1);
});

test('usage-reporting embedders surface spend deltas in run stats', async (context) => {
	const directory = workspace(context);
	const state = { requests: 0, tokens: 0 };
	const embedder = fakeUsageEmbedder('fake:billed:4', 4, state);
	await refreshIndex({ directory, embedder, files: fixtureFiles() });
	const second = await refreshIndex({ directory, embedder, files: fixtureFiles() });
	// Second run embedded nothing, so its delta is zero even though cumulative counters grew.
	assert.equal(second.stats.apiRequests, 0);
	assert.equal(second.stats.promptTokens, 0);
	assert.equal(second.stats.costUsd, undefined);

	state.requests += 5;
	state.tokens += 50;
	const freshDir = join(directory, '..', 'fresh-index');
	const third = await refreshIndex({ directory: freshDir, embedder, files: fixtureFiles() });
	assert.equal(third.stats.apiRequests, 3);
	assert.equal(third.stats.promptTokens, 30);
});

test('corruption throws instead of masquerading as absence', async (context) => {
	const directory = workspace(context);
	const fake = fakeEmbedder();
	await refreshIndex({ directory, embedder: fake.embedder, files: fixtureFiles() });

	const truncateVectors = (): void => {
		const path = join(directory, 'vectors.bin');
		const bytes = readFileSync(path);
		writeFileSync(path, bytes.subarray(0, bytes.byteLength - 8));
	};
	truncateVectors();
	assert.throws(() => readIndex(directory), /norbital-doctor:.*entries reference.*float32s/);

	writeFileSync(join(directory, 'manifest.json'), '{not json');
	assert.throws(() => readIndex(directory), /norbital-doctor: index manifest .* is not valid JSON/);

	writeFileSync(
		join(directory, 'manifest.json'),
		JSON.stringify({ indexSchema: 99 })
	);
	assert.throws(() => readIndex(directory), /unsupported indexSchema 99/);

	writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ indexSchema: 1 }));
	assert.throws(() => readIndex(directory), /has no embedderId/);
});

test('entry-level inconsistencies fail loudly', async (context) => {
	const directory = workspace(context);
	await refreshIndex({ directory, embedder: fakeEmbedder().embedder, files: fixtureFiles() });

	const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8') as string);
	manifest.dimensions = 'four';
	writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
	assert.throws(() => readIndex(directory), /non-finite or invalid dimensions/);

	manifest.dimensions = 4;
	manifest.files = ['src/alpha.ts'];
	writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
	assert.throws(() => readIndex(directory), /disagrees with entries\.jsonl/);

	manifest.files = ['src/alpha.ts', 'src/beta.ts', 'lib/gamma.ts'];
	writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
	writeFileSync(
		join(directory, 'entries.jsonl'),
		readFileSync(join(directory, 'entries.jsonl'), 'utf8')
			.split('\n')
			.map((line) =>
				line.includes('"src/alpha.ts"')
					? JSON.stringify({ path: 'src/alpha.ts', hash: 'h', offset: -1, length: 4 })
					: line
			)
			.join('\n')
	);
	assert.throws(() => readIndex(directory), /not a valid entry record/);
});

test('a mid-write failure leaves the committed index untouched', async (context) => {
	const directory = workspace(context);
	const before = fakeEmbedder();
	await refreshIndex({ directory, embedder: before.embedder, files: fixtureFiles() });
	const snapshotBefore = readIndex(directory);
	const manifestBefore = readFileSync(join(directory, 'manifest.json')).toString();

	// Block exactly the tmp write of vectors.bin.
	mkdirSync(join(directory, `vectors.bin.${process.pid}.tmp`));

	const mutated = fixtureFiles();
	mutated.set('src/alpha.ts', { hash: createHash('sha256').update('divergent').digest('hex'), text: 'divergent' });
	await assert.rejects(
		refreshIndex({ directory, embedder: fakeEmbedder().embedder, files: mutated }),
		/EISDIR/
	);

	const snapshotAfter = readIndex(directory);
	assert.deepEqual(snapshotAfter?.merkleRoot, snapshotBefore?.merkleRoot);
	assert.deepEqual([...(snapshotAfter?.entries.values() ?? [])], [
		...(snapshotBefore?.entries.values() ?? [])
	]);
	assert.equal(readFileSync(join(directory, 'manifest.json')).toString(), manifestBefore);

	rmSync(join(directory, `vectors.bin.${process.pid}.tmp`), { recursive: true });
	const recovery = await refreshIndex({
		directory,
		embedder: fakeEmbedder().embedder,
		files: mutated
	});
	assert.equal(recovery.stats.filesEmbedded, 1);
});

test('refreshing an empty file set writes an empty-but-valid index', async (context) => {
	const directory = workspace(context);
	const fake = fakeEmbedder();
	const result = await refreshIndex({ directory, embedder: fake.embedder, files: new Map() });
	assert.equal(fake.calls.length, 0);
	assert.equal(result.root, createHash('sha256').update('').digest('hex'));
	assert.equal(result.vectors.size, 0);
	assert.equal(result.stats.filesTotal, 0);
	const snapshot = readIndex(directory);
	assert.equal(snapshot?.merkleRoot, result.root);
});
