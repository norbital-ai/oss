/**
 * The semantic findings and query evaluation, against hand-built clusters so the arithmetic is
 * checkable by eye. The threshold boundary test computes the expected cosine with the same
 * exported `cosineSimilarity` the implementation family uses, then probes one ulp above it —
 * inclusive-at-exactly is the contract, and that is how you catch an off-by-epsilon in either
 * direction.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Cluster } from '../../build/semantic/cluster.js';
import { cosineSimilarity } from '../../build/semantic/cluster.js';
import { TWIN_THRESHOLD, evaluateQueries, overlapFindings } from '../../build/semantic/analyze.js';
import type { Embedder, EmbedKind } from '../../build/semantic/embedder.js';

const cluster = (overrides: Partial<Cluster>): Cluster => ({
	label: 'billing/invoice',
	members: [],
	similarity: 0.9,
	pairs: [],
	...overrides
});

test('SEM_SPREAD reports each member outside the majority owner with full evidence', () => {
	const spread = cluster({
		members: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
		similarity: 0.9123
	});
	const findings = overlapFindings({
		clusters: [spread],
		ownerOf: (path) => (path === 'src/c.ts' ? 'team-b' : 'team-a')
	});
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.rule, 'SEM_SPREAD');
	assert.equal(findings[0]?.location, 'src/c.ts');
	assert.equal(
		findings[0]?.evidence,
		'label=billing/invoice owners=team-a,team-b similarity=0.912'
	);
	assert.match(findings[0]?.summary ?? /$/, /majority owner|mostly under team-a/);
});

test('an owner tie resolves to the lexicographically smaller majority', () => {
	const tied = cluster({ members: ['m-b.ts', 'm-a.ts'], similarity: 0.88 });
	const findings = overlapFindings({
		clusters: [tied],
		ownerOf: (path) => (path === 'm-a.ts' ? 'zeta' : 'alpha')
	});
	// alpha and zeta each own one file; the majority is `alpha` (lexicographically first), so the
	// outlier is m-a.ts under zeta.
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.location, 'm-a.ts');
	assert.match(findings[0]?.evidence ?? /$/, /owners=alpha,zeta/);
});

test('single-owner clusters produce no spread findings', () => {
	const findings = overlapFindings({
		clusters: [cluster({ members: ['x.ts', 'y.ts'] })],
		ownerOf: () => 'solo'
	});
	assert.deepEqual(findings, []);
});

const twinCluster = (similarity: number): Cluster =>
	cluster({
		label: 'auth/session',
		members: ['pkg-one/session.ts', 'pkg-two/session.ts'],
		pairs: [
			{
				a: 'pkg-one/session.ts',
				b: 'pkg-two/session.ts',
				similarity
			}
		]
	});

test('SEM_TWIN fires for cross-owner pairs at or above the threshold and honours exemptions', () => {
	// A cross-owner twin cluster legitimately also triggers SEM_SPREAD; filter to the twin rule.
	const findings = overlapFindings({
		clusters: [twinCluster(0.95)],
		ownerOf: (path) => (path.startsWith('pkg-one') ? 'one' : 'two')
	}).filter((finding) => finding.rule === 'SEM_TWIN');
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.location, 'pkg-one/session.ts <-> pkg-two/session.ts');
	assert.equal(TWIN_THRESHOLD, 0.93);

	const exempted = overlapFindings({
		clusters: [twinCluster(0.95)],
		ownerOf: (path) => (path.startsWith('pkg-one') ? 'one' : 'two'),
		exemptPairs: ['pkg-one/session.ts\u0000pkg-two/session.ts']
	}).filter((finding) => finding.rule === 'SEM_TWIN');
	assert.deepEqual(exempted, []);
});

test('pairs below the twin threshold and same-owner pairs stay quiet', () => {
	const quietOwners = overlapFindings({
		clusters: [twinCluster(0.999)],
		ownerOf: () => 'same'
	});
	assert.deepEqual(quietOwners, []);

	// Below the twin threshold no SEM_TWIN fires — the ownership spread still does, by design.
	const belowThreshold = overlapFindings({
		clusters: [twinCluster(TWIN_THRESHOLD - 0.001)],
		ownerOf: (path) => (path.startsWith('pkg-one') ? 'one' : 'two')
	});
	assert.equal(belowThreshold.some((finding) => finding.rule === 'SEM_TWIN'), false);
});

test('findings are sorted by rule then location', () => {
	const mixed = cluster({
		members: ['b.ts', 'a.ts', 'c.ts'],
		similarity: 0.99,
		pairs: [
			{ a: 'a.ts', b: 'c.ts', similarity: 0.99 },
			{ a: 'a.ts', b: 'b.ts', similarity: 0.99 }
		]
	});
	const findings = overlapFindings({
		clusters: [mixed],
		ownerOf: (path) => (path === 'c.ts' ? 'other' : 'main')
	});
	// The a/b pair shares an owner and stays quiet; only the cross-owner a/c pair reports.
	assert.deepEqual(
		findings.map((finding) => [finding.rule, finding.location]),
		[
			['SEM_SPREAD', 'c.ts'],
			['SEM_TWIN', 'a.ts <-> c.ts']
		]
	);
});

const scriptedEmbedder = (
	vectorsByInput: ReadonlyArray<Float32Array>
): Embedder & { calls: Array<{ kind: EmbedKind; texts: ReadonlyArray<string> }> } => {
	const calls: Array<{ kind: EmbedKind; texts: ReadonlyArray<string> }> = [];
	return {
		id: 'scripted:4',
		dimensions: 4,
		calls,
		embed: async (texts, kind) => {
			calls.push({ kind, texts: [...texts] });
			return [...vectorsByInput];
		}
	};
};

test('evaluateQueries embeds queries as queries, keeps hits at exactly the threshold, and sorts desc', async () => {
	const docNear = new Float32Array([1, 0, 0, 0]);
	const docFar = new Float32Array([0, 1, 0, 0]);
	const queryVector = new Float32Array([2, 0, 0, 0]); // unnormalized on purpose
	const vectors = new Map([
		['near.ts', docNear],
		['far.ts', docFar]
	]);
	const exact = cosineSimilarity(queryVector, docNear); // 1.0
	const embedder = scriptedEmbedder([queryVector]);

	const hits = await evaluateQueries({
		queries: [{ ruleId: 'SEM_Q1', text: 'session handling', threshold: exact }],
		vectors,
		embedder
	});
	assert.deepEqual(embedder.calls[0]?.kind, 'query');
	assert.deepEqual(hits, [{ ruleId: 'SEM_Q1', path: 'near.ts', similarity: exact }]);
	assert.equal(hits.every((hit) => hit.similarity >= 1), true);

	const strict = await evaluateQueries({
		queries: [{ ruleId: 'SEM_Q1', text: 'session handling', threshold: exact * (1 + 1e-12) }],
		vectors,
		embedder: scriptedEmbedder([queryVector])
	});
	assert.deepEqual(strict, []);

	const both = await evaluateQueries({
		embedder: scriptedEmbedder([docNear, new Float32Array([0.6, 0.8, 0, 0])]),
		queries: [
			{ ruleId: 'Q-low', text: 'a', threshold: 0 },
			{ ruleId: 'Q-high', text: 'b', threshold: 0 }
		],
		vectors
	});
	assert.equal(both.length, 4);
	assert.equal(both[0]?.similarity >= (both[1]?.similarity ?? 0), true);
});

test('evaluateQueries short-circuits empty inputs', async () => {
	assert.deepEqual(
		await evaluateQueries({
			queries: [],
			vectors: new Map([['x', new Float32Array([1])]]),
			embedder: scriptedEmbedder([])
		}),
		[]
	);
});

test('a twin is found even when kNN neighbors starve its edge', async () => {
	// The scenario this regression pins: pkg-a and pkg-b each hold a dozen files whose pairwise
	// similarity is high (0.98) — so every kNN edge stays inside its own package — while one
	// identical file exists in BOTH packages. The kNN pass never links the packages; only the
	// full-scan candidate pass can name the pair.
	const makeVector = (seed: number): Float32Array => {
		const v = new Float32Array(3);
		v[0] = 1;
		v[1] = 0.1 + (seed % 7) * 0.001;
		v[2] = 0.001 * (seed % 3);
		return v;
	};
	const items: Array<{ path: string; vector: Float32Array }> = [];
	for (let i = 0; i < 12; i += 1)
		items.push({ path: `pkg-a/mod-${i}.ts`, vector: makeVector(i) });
	for (let i = 0; i < 12; i += 1)
		items.push({ path: `pkg-b/mod-${i}.ts`, vector: makeVector(i) });

	const { collectTwinCandidates } = await import('../../build/semantic/analyze.js');
	const { clusterFilesDetailed } = await import('../../build/semantic/cluster.js');
	const candidates = collectTwinCandidates(items, 0.85, new Set());
	const clusters = clusterFilesDetailed(items as never, { threshold: 0.85 });
	const ownerOf = (path: string): string => path.split('/')[0] ?? '';
	const twins = overlapFindings({
		clusters: clusters.clusters as never,
		ownerOf,
		twinCandidates: candidates
	}).filter((finding) => finding.rule === 'SEM_TWIN');
	// Pairwise at ~0.998 every candidate is a twin, so the pass must produce them by the score.
	assert.ok(twins.length >= 1, 'full-scan twins must surface even under kNN starvation');
	assert.match(twins[0]?.location ?? '', /<->/);
});
