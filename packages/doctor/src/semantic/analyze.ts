/**
 * The two pure judgments the semantic tier renders, kept free of I/O so both are testable against
 * hand-built vectors.
 *
 * `overlapFindings` turns clusters into findings. SEM_SPREAD fires when one responsibility is
 * scattered across teams — the majority owner defines the cluster's home, and every file outside
 * it is a finding, because "move it or give it a distinct home" needs an addressee. SEM_TWIN fires
 * on near-duplicate files under different owners at very high cosine: below the clustering
 * threshold these would never share a cluster edge reliably, so twins are checked pairwise inside
 * clusters rather than assumed by membership. Exempt pairs exist because some duplication is
 * deliberate (generated mirrors, vendored copies) and the config, not a heuristic, should say so.
 *
 * `evaluateQueries` is the authored-rule surface: embed the query once, cosine against the index,
 * report hits at or above each rule's threshold. The boundary is inclusive — "at least this
 * similar" is what a threshold reads as to the person who wrote it.
 */
import type { Embedder } from './embedder.js';
import { cosineSimilarity } from './cluster.js';
import type { Cluster, ClusterPair } from './cluster.js';

/** Cosine above which two differently-owned files are considered twins. */
export const TWIN_THRESHOLD = 0.93;

type SemanticFindingRule = 'SEM_SPREAD' | 'SEM_TWIN' | 'SEM_PARALLEL';

type SemanticFinding = Readonly<{
	readonly rule: SemanticFindingRule;
	readonly location: string;
	readonly evidence: string;
	readonly summary: string;
}>;

const pairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

type OverlapFindingsOptions = Readonly<{
	readonly clusters: ReadonlyArray<Cluster>;
	readonly ownerOf: (path: string) => string;
	/** Additional cross-cluster candidate pairs from the full-scan twin pass. */
	readonly twinCandidates?: ReadonlyArray<ClusterPair> | undefined;
	/** Mutually-nearest pairs: the parallel-implementation signal from the cluster pass. */
	readonly mutualNearest?: ReadonlyArray<ClusterPair> | undefined;
	/** Pair keys (`a\0b`, paths sorted) deliberately excluded from twin reporting. */
	readonly exemptPairs?: ReadonlyArray<string> | undefined;
}>;

/**
 * Findings for ownership spread and cross-owner twins. Sorted by rule then location so catalogue
 * output is byte-stable across runs.
 */
function spreadFindings(
	cluster: Cluster,
	ownersByPath: ReadonlyMap<string, string>,
	tally: ReadonlyMap<string, number>,
	findings: Array<SemanticFinding>
): void {
	if (tally.size < 2) return;
	const ownersRanked = [...tally].sort(
		([leftOwner, leftCount], [rightOwner, rightCount]) =>
			rightCount - leftCount || (leftOwner < rightOwner ? -1 : 1)
	);
	const majority = ownersRanked[0]?.[0] ?? '';
	const owners = [...tally.keys()].sort();
	const evidence = `label=${cluster.label} owners=${owners.join(',')} similarity=${cluster.similarity.toFixed(3)}`;
	for (const path of cluster.members) {
		const owner = ownersByPath.get(path) ?? '';
		if (owner === majority) continue;
		findings.push({
			rule: 'SEM_SPREAD',
			location: path,
			evidence,
			summary: `responsibility "${cluster.label}" lives mostly under ${majority}; ${path} sits under ${owner} — move it there or split the responsibility`
		});
	}
}

function twinFindings(
	cluster: Cluster,
	ownersByPath: ReadonlyMap<string, string>,
	exempt: ReadonlySet<string>,
	findings: Array<SemanticFinding>,
	candidates?: ReadonlyArray<ClusterPair> | undefined
): void {
	const pairs =
		candidates !== undefined && candidates.length > 0
			? [...cluster.pairs, ...candidates]
			: cluster.pairs;
	for (const pair of pairs) {
		if (pair.similarity < TWIN_THRESHOLD) continue;
		const ownerA = ownersByPath.get(pair.a) ?? '';
		const ownerB = ownersByPath.get(pair.b) ?? '';
		if (ownerA === ownerB) continue;
		if (exempt.has(pairKey(pair.a, pair.b))) continue;
		findings.push({
			rule: 'SEM_TWIN',
			location: `${pair.a} <-> ${pair.b}`,
			evidence: `label=${cluster.label} similarity=${pair.similarity.toFixed(3)} owners=${ownerA},${ownerB}`,
			summary: `${pair.a} and ${pair.b} are near-duplicates owned by ${ownerA} and ${ownerB} — extract one shared module`
		});
	}
}

/**
 * Cross-package candidate pairs above the twin threshold, found by full scan rather than by
 * kNN adjacency.
 *
 * kNN edges are the clustering contract — ten neighbours or fewer — but a twin is not a neighbor:
 * two near-identical files in different packages usually have their own package's cousins closer,
 * which is precisely the noise that makes them invisible to the edge scan. Twin detection then
 * answers a question no one asked. So the twin pass reads the whole upper triangle once; the
 * similarity matrix is streamed row by row, and the N² cost is bounded from the caller by
 * `TWIN_THRESHOLD` because the vector dot product drops out at far lower similarity than code
 * files like this share.
 */
export function collectTwinCandidates(
	items: ReadonlyArray<{ path: string; vector: Float32Array }>,
	threshold: number,
	exclude: ReadonlySet<string>
): Array<ClusterPair> {
	const candidates: Array<ClusterPair> = [];
	for (let left = 0; left < items.length; left += 1) {
		const a = items[left];
		if (a === undefined) continue;
		for (let right = left + 1; right < items.length; right += 1) {
			const b = items[right];
			if (b === undefined) continue;
			const key = pairKey(a.path, b.path);
			if (exclude.has(key)) continue;
			const similarity = cosineSimilarity(a.vector, b.vector);
			if (similarity < threshold) continue;
			candidates.push({ a: a.path, b: b.path, similarity });
		}
	}
	return candidates;
}

function parallelFindings(
	pairs: ReadonlyArray<ClusterPair> | undefined,
	ownerOf: (path: string) => string,
	exempt: ReadonlySet<string>,
	findings: Array<SemanticFinding>
): void {
	if (pairs === undefined) return;
	for (const pair of pairs) {
		if (exempt.has(pairKey(pair.a, pair.b))) continue;
		const ownerA = ownerOf(pair.a);
		const ownerB = ownerOf(pair.b);
		findings.push({
			rule: 'SEM_PARALLEL',
			location: `${pair.a} <-> ${pair.b}`,
			evidence: `mutual-nearest similarity=${pair.similarity.toFixed(3)} owners=${ownerA},${ownerB}`,
			summary: `${pair.a} and ${pair.b} are each other's nearest module — one responsibility implemented twice`
		});
	}
}

export function overlapFindings(options: OverlapFindingsOptions): Array<SemanticFinding> {
	const { ownerOf } = options;
	const exempt = new Set(options.exemptPairs ?? []);
	const findings: Array<SemanticFinding> = [];

	for (const cluster of options.clusters) {
		const ownersByPath = new Map<string, string>(
			cluster.members.map((path) => [path, ownerOf(path)])
		);
		const tally = new Map<string, number>();
		for (const owner of ownersByPath.values())
			tally.set(owner, (tally.get(owner) ?? 0) + 1);

		spreadFindings(cluster, ownersByPath, tally, findings);
		twinFindings(cluster, ownersByPath, exempt, findings, options.twinCandidates);
	}

	parallelFindings(options.mutualNearest, ownerOf, exempt, findings);

	const ruleRank: Readonly<Record<SemanticFindingRule, number>> = {
		SEM_SPREAD: 0,
		SEM_TWIN: 1,
		SEM_PARALLEL: 2
	};
	return findings.sort(
		(left, right) =>
			ruleRank[left.rule] - ruleRank[right.rule] ||
			(left.location < right.location ? -1 : 1)
	);
}

type QuerySpec = Readonly<{
	readonly ruleId: string;
	readonly text: string;
	readonly threshold: number;
}>;

type QueryHit = Readonly<{
	readonly ruleId: string;
	readonly path: string;
	readonly similarity: number;
}>;

type EvaluateQueriesOptions = Readonly<{
	readonly queries: ReadonlyArray<QuerySpec>;
	readonly vectors: ReadonlyMap<string, Float32Array>;
	readonly embedder: Embedder;
}>;

/**
 * Embed each query with kind `'query'` (the provider applies its query-side convention), compare
 * against every indexed vector, and return hits at or above their rule's threshold, most similar
 * first.
 */
export async function evaluateQueries(options: EvaluateQueriesOptions): Promise<Array<QueryHit>> {
	const { queries, vectors, embedder } = options;
	if (queries.length === 0 || vectors.size === 0) return [];

	const queryVectors = await embedder.embed(
		queries.map((query) => query.text),
		'query'
	);
	if (queryVectors.length !== queries.length)
		throw new Error(
			`norbital-doctor: embedder returned ${queryVectors.length} query vectors for ${queries.length} queries`
		);

	const hits: Array<{ ruleId: string; path: string; similarity: number }> = [];
	for (const [index, query] of queries.entries()) {
		const queryVector = queryVectors[index];
		if (queryVector === undefined)
			throw new Error(`norbital-doctor: missing query vector for rule ${query.ruleId}`);
		for (const [path, vector] of vectors) {
			if (vector.length !== queryVector.length)
				throw new Error(
					`norbital-doctor: query for rule ${query.ruleId} has ${queryVector.length} dimensions but index vector for ${path} has ${vector.length}`
				);
			let dot = 0;
			let normQuery = 0;
			let normStored = 0;
			for (let slot = 0; slot < queryVector.length; slot += 1) {
				const x = queryVector[slot] ?? 0;
				const y = vector[slot] ?? 0;
				dot += x * y;
				normQuery += x * x;
				normStored += y * y;
			}
			const similarity =
				normQuery === 0 || normStored === 0 ? 0 : dot / Math.sqrt(normQuery * normStored);
			if (similarity >= query.threshold)
				hits.push({ ruleId: query.ruleId, path, similarity });
		}
	}

	return hits.sort(
		(left, right) =>
			right.similarity - left.similarity ||
			(left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0) ||
			(left.path < right.path ? -1 : 1)
	);
}

/** Re-exported so callers of the findings need not import the clustering module too. */
export type { Cluster, ClusterPair };
