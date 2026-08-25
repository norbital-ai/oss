/**
 * The semantic tier end-to-end, offline.
 *
 * An inline provider keeps this honest about wiring rather than about embeddings: the tier must
 * build an index, reuse it untouched across identical trees, account for what it did, evaluate
 * pseudocode halves against committed vectors, and write every number into a receipt the typed
 * analyzer authenticates. A hash-bag embedder makes similarity a construction instead of a hope.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import test from 'node:test';
import { audit } from '../build/index.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..').split(sep).join('/');

function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `probe-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['add', '-A'], { cwd: root });
	return root;
}

/** Deterministic 4-dim bag-of-signatures: axis 0 fetch, 1 retry/backoff, 2 parse/json, 3 list. */
const AXES: ReadonlyArray<readonly [RegExp, number]> = [
	[/\bfetch\s*\(/, 0],
	[/backoff|retry/i, 1],
	[/JSON\.parse/, 2],
	[/\.map\(/, 3]
];

function bagVector(texts: ReadonlyArray<string>): Array<Array<number>> {
	return texts.map((text) => {
		const vector = [0, 0, 0, 0];
		for (const [pattern, axis] of AXES)
			if (pattern.test(text)) vector[axis] = 1;
		const norm = Math.hypot(...vector) || 1;
		return vector.map((value) => value / norm);
	});
}

// Serialized into fixture configs, so it must be closure-free: it runs in the audit worker.
const PROVIDER_TEXT = `async (texts, kind) => {
	const axes = [[/\\bfetch\\s*\\(/, 0], [/backoff|retry/i, 1], [/JSON\\.parse/, 2], [/\\.map\\(/, 3]];
	return texts.map((text) => {
		const vector = [0, 0, 0, 0];
		for (const [pattern, axis] of axes)
			if ((kind === 'query' ? text : text).match(pattern)) vector[axis] = 1;
		const norm = Math.hypot(...vector) || 1;
		return vector.map((value) => value / norm);
	});
}`;

const CONFIG = `import { defineConfig } from '@norbital-ai/doctor';
export default defineConfig({
	semantic: {
		provider: ${PROVIDER_TEXT},
		dimensions: 4
	},
	patterns: 'dr/*.yml'
});
`;

test('the semantic tier indexes, reuses, bills, answers pseudocode, and writes a v6 receipt', async (context) => {
	const root = repository('semantic-tier', {
		'package.json': '{"name":"sem","type":"module"}',
		'src/http.ts': 'export const get = (): unknown => fetch("/x").then((r) => r.json());\n',
		// The similarity signal lives in code, deliberately: the skeleton strips comments before
		// embedding, so a comment-borne signal would never reach the vector.
		'src/retry.ts':
			'const backoff = (attempt: number): number => attempt * 2;\nexport const again = (): unknown => {\n\tfetch("/y");\n\treturn backoff(2);\n};\n',
		'dr/retries.yml': [
			'id: RETRY_SEM',
			'summary: hand-rolled retry around async work',
			'severity: error',
			'principles: [simplicity]',
			'pseudocode: |',
			'\tretry with backoff around a network call'.replace('\t', '  '),
			'threshold: 0.3',
			''
		].join('\n'),
		'doctor.config.mts': CONFIG
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const first = await audit({ root });
	assert.equal(first.receipt.schemaVersion, 6);
	assert.equal(first.receipt.tiers.semantic, true);
	assert.match(first.receipt.embedderId ?? '', /^custom:/);
	assert.match(first.receipt.indexDigest ?? '', /^[0-9a-f]{64}$/);
	// Three sources entered the audit: the two modules and the config that declares the provider.
	assert.equal(first.semantic.stats?.filesTotal, 3);
	assert.equal(first.semantic.stats?.filesEmbedded, 3);
	assert.equal(first.semantic.stats?.filesUnchanged, 0);

	// The pseudocode half fired against the retry file — and the assertion survives any
	// additional hit (the config file quotes the same words its provider matches on).
	const hits = first.findings.filter((finding) => finding.rule === 'RETRY_SEM');
	assert.ok(
		hits.some((finding) => /^src\/retry\.ts:1: \[semantic=\d\.\d+\]$/.test(finding.location)),
		`expected a retry.ts hit, saw ${JSON.stringify(hits.map((finding) => finding.location))}`
	);

	// The bill is written where a person reads it: beside the catalogue, in the receipt.
	assert.equal(readFileSync(first.metricsPath, 'utf8').startsWith('kind\tfile\tline\tname'), true);
	const receiptOnDisk = JSON.parse(
		readFileSync(join(root, '.norbital/diagnosis/receipt.json'), 'utf8')
	) as { indexing?: { filesEmbedded?: number; durationMs?: number } };
	assert.equal(receiptOnDisk.indexing?.filesEmbedded, 3);
	assert.ok(typeof receiptOnDisk.indexing?.durationMs === 'number');

	// A second audit of an untouched tree embeds nothing: the Merkle diff prunes everything, so
	// the incremental contract is visible in the spend counters themselves.
	const second = await audit({ root });
	assert.equal(second.semantic.stats?.filesEmbedded, 0);
	assert.equal(second.semantic.stats?.filesUnchanged, 3);
});

test('the CLI prints the semantic bill', (context) => {
	const root = repository('semantic-cli', {
		'package.json': '{"name":"sem-cli","type":"module"}',
		// A script directory is a framework entrypoint, so the neutral baseline stays quiet and
		// the CLI exits 0 with only the semantic bill to print.
		'scripts/x.ts': 'export const x = JSON.parse("{}");\n',
		'doctor.config.mts': CONFIG.replace(`patterns: 'dr/*.yml'`, '')
			.replace('dimensions: 4', 'dimensions: 4')
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const output = execFileSync(
		process.execPath,
		[join(PACKAGE_ROOT, 'build/cli.js'), '--root', root],
		{ encoding: 'utf8' }
	);
	assert.match(output, /^semantic: custom:provider:4 · [0-9]+ clusters, [0-9]+ singletons · 2 embedded, 0 reused/m);
});
