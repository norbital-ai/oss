/**
 * Deterministic clustering over file embeddings — the bridge between "vectors exist" and
 * "findings name files".
 *
 * The graph is kNN-with-threshold: each file links to at most its ten most similar neighbours,
 * and an edge survives only above the cosine threshold. Pure threshold-all-pairs would turn one
 * hub file into a cluster the size of the repository; pure kNN without a floor would chain every
 * vector to every other through enough hops. The two together keep clusters local and explainable.
 * Union-find with smallest-index roots makes group identity independent of iteration order.
 *
 * Every derived field a downstream rule needs is computed here, where the vectors are still in
 * hand: the label (top tokens across member names), the minimum internal cosine (the honest
 * similarity number for evidence strings), and the strong within-cluster pairs (twin detection's
 * raw material). `analyze` deliberately receives no vectors — clusters are self-contained facts.
 *
 * Singletons are omitted from the returned clusters but reported in the detailed summary:
 * "nothing matched" and "one file stood alone" are different receipts.
 */

const DEFAULT_CLUSTER_THRESHOLD = 0.85;
const DEFAULT_NEIGHBORS = 10;

/**
 * Floor for a mutually-nearest pair to count as a parallel-implementation signal.
 *
 * Below the clustering threshold on purpose: pairs at this distance share the job's vocabulary
 * while their mechanism words differ — exactly the parallel-implementation shape. The signal is
 * *reciprocity*, not similarity alone, so the floor can sit in the middle of the noisy band
 * without inviting sibling chrome.
 */
const MIN_PARALLEL_SIMILARITY = 0.75;

export type ClusterItem = Readonly<{
	readonly path: string;
	readonly vector: Float32Array;
	/** Human-ish identifier the label tokens come from; usually the basename without extension. */
	readonly name: string;
}>;

export type ClusterPair = Readonly<{ a: string; b: string; similarity: number }>;

export type Cluster = Readonly<{
	readonly label: string;
	/** Member paths, sorted. */
	readonly members: ReadonlyArray<string>;
	/** Minimum internal pairwise cosine — the weakest link, which is the honest one to report. */
	readonly similarity: number;
	/** Within-cluster pairs at or above the clustering threshold, sorted. */
	readonly pairs: ReadonlyArray<ClusterPair>;
}>;

type ClusterOptions = Readonly<{
	/** Cosine floor for an edge. Default `DEFAULT_CLUSTER_THRESHOLD`. */
	readonly threshold?: number | undefined;
	/** Neighbours per file considered for an edge. Default `DEFAULT_NEIGHBORS`. */
	readonly neighbors?: number | undefined;
}>;

type ClusterReport = Readonly<{
	readonly clusters: ReadonlyArray<Cluster>;
	readonly singletons: ReadonlyArray<string>;
	/**
	 * Mutually-nearest pairs: each file is the other's closest vector, above the parallel floor.
	 *
	 * Clustering answers "which files share a responsibility"; twins answer "which two packages
	 * duplicated one". Neither answers "two different implementations of one job" — that pair sits
	 * *below* the cluster edge, because mechanism words (worker vs vm, spawn vs splice) outweigh
	 * job words, and it often lives inside one package, where the cross-owner twin rule is
	 * silent by design. Mutual nearest-neighbour is the third signal: it needs no threshold
	 * below the floor, only reciprocity.
	 */
	readonly mutualNearest: ReadonlyArray<ClusterPair>;
}>;

/**
 * Cosine of two vectors of equal length; zero-norm vectors score zero against everything rather
 * than NaN, because an empty embedding should not poison a comparison with arithmetic noise.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length)
		throw new Error(`norbital-doctor: cosine of vectors of different widths ${a.length} vs ${b.length}`);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let index = 0; index < a.length; index += 1) {
		const x = a[index] ?? 0;
		const y = b[index] ?? 0;
		dot += x * y;
		normA += x * x;
		normB += y * y;
	}
	if (normA === 0 || normB === 0) return 0;
	return dot / Math.sqrt(normA * normB);
}

const normalizedCopy = (vector: Float32Array): Float32Array => {
	const copy = new Float32Array(vector.length);
	let sum = 0;
	for (const value of vector) sum += value * value;
	if (sum === 0) return copy;
	const scale = 1 / Math.sqrt(sum);
	for (const [index, value] of vector.entries()) copy[index] = value * scale;
	return copy;
};

/**
 * Lowercase identifier words from a name, splitting on camel humps, hyphens and underscores.
 * This feeds labels, so it must be stable under input that is already lowercase or already split.
 */
const nameTokens = (name: string): Array<string> =>
	name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((token) => token !== '');

/** The three most frequent member-name tokens, ties broken lexicographically, joined with `/`. */
function labelFor(names: ReadonlyArray<string>): string {
	const counts = new Map<string, number>();
	for (const name of names)
		for (const token of nameTokens(name)) counts.set(token, (counts.get(token) ?? 0) + 1);
	const ranked = [...counts].sort(
		([leftWord, leftCount], [rightWord, rightCount]) =>
			rightCount - leftCount || (leftWord < rightWord ? -1 : 1)
	);
	const top = ranked.slice(0, 3).map(([word]) => word);
	return top.length === 0 ? 'unnamed' : top.join('/');
}

class UnionFind {
	private readonly parent: Array<number>;

	constructor(size: number) {
		this.parent = Array.from({ length: size }, (_, index) => index);
	}

	find(node: number): number {
		let root = node;
		while (this.parent[root] !== root) root = this.parent[root] ?? root;
		while (this.parent[node] !== root) {
			const next = this.parent[node] ?? node;
			this.parent[node] = root;
			node = next;
		}
		return root;
	}

	union(left: number, right: number): void {
		const leftRoot = this.find(left);
		const rightRoot = this.find(right);
		if (leftRoot === rightRoot) return;
		// Smaller index wins so the surviving root depends only on insertion order, which is
		// itself pinned by sorted paths upstream.
		if (leftRoot < rightRoot) this.parent[rightRoot] = leftRoot;
		else this.parent[leftRoot] = rightRoot;
	}
}

/**
 * Cluster files by embedding similarity. Returns only multi-member clusters, sorted by first
 * member path, members sorted inside each. See `clusterFilesDetailed` for the singleton receipt.
 */
export function clusterFiles(
	items: ReadonlyArray<ClusterItem>,
	options: ClusterOptions = {}
): ReadonlyArray<Cluster> {
	return clusterFilesDetailed(items, options).clusters;
}

/** As `clusterFiles`, plus the singleton paths that the cluster list omits. */
function clusterOf(
	members: ReadonlyArray<number>,
	similarities: ReadonlyArray<Float64Array>,
	items: ReadonlyArray<ClusterItem>,
	paths: ReadonlyArray<string>,
	threshold: number
): Cluster {
	// One canonical pass order per component: by path. Members, label tokens, pairs and the
	// minimum-similarity scan all walk this sequence, so endpoints land as `a < b`.
	const ordered = [...members].sort((left, right) =>
		(paths[left] ?? '') < (paths[right] ?? '') ? -1 : 1
	);
	const memberPaths = ordered.map((index) => paths[index] ?? '');
	let minSimilarity = Number.POSITIVE_INFINITY;
	const pairs: Array<ClusterPair> = [];
	for (const [slot, i] of ordered.entries()) {
		for (const j of ordered.slice(slot + 1)) {
			const similarity = similarities[i]?.[j];
			if (similarity === undefined) continue;
			minSimilarity = Math.min(minSimilarity, similarity);
			if (similarity >= threshold)
				pairs.push({ a: paths[i] ?? '', b: paths[j] ?? '', similarity });
		}
	}
	return {
		label: labelFor(ordered.map((index) => items[index]?.name ?? '')),
		members: memberPaths,
		similarity: minSimilarity === Number.POSITIVE_INFINITY ? 0 : minSimilarity,
		pairs: pairs.sort((left, right) =>
			left.a < right.a ? -1 : left.a > right.a ? 1 : left.b < right.b ? -1 : 1
		)
	};
}

export function clusterFilesDetailed(
	items: ReadonlyArray<ClusterItem>,
	options: ClusterOptions = {}
): ClusterReport {
	const count = items.length;
	if (count === 0) return { clusters: [], singletons: [], mutualNearest: [] };

	const threshold = options.threshold ?? DEFAULT_CLUSTER_THRESHOLD;
	const neighbors = options.neighbors ?? DEFAULT_NEIGHBORS;

	// Everything below works in the caller's index space; ordering is applied only where values
	// leave this function, so no internal permutation can ever desynchronize an index from the
	// vector or path it names.
	const vectors = items.map((item) => normalizedCopy(item.vector));
	const paths = items.map((item) => item.path);

	// Full pairwise matrix once: n is files-in-repository scale, and both the kNN pass and the
	// per-cluster pair/min-similarity bookkeeping read from it.
	const similarities: Array<Float64Array> = [];
	for (let i = 0; i < count; i += 1) {
		const left = vectors[i];
		if (left === undefined)
			throw new Error('norbital-doctor: clustering lost a vector while comparing');
		const row = new Float64Array(count);
		for (let j = 0; j < count; j += 1) {
			const right = vectors[j];
			row[j] =
				i === j || right === undefined ? Number.NaN : cosineSimilarity(left, right);
		}
		similarities.push(row);
	}

	const groups = new UnionFind(count);
	for (let i = 0; i < count; i += 1) {
		const row = similarities[i];
		if (row === undefined)
			throw new Error('norbital-doctor: clustering lost a comparison row');
		const candidates: Array<{ j: number; similarity: number }> = [];
		for (let j = 0; j < count; j += 1) {
			const similarity = row[j];
			if (j !== i && similarity !== undefined && similarity >= threshold)
				candidates.push({ j, similarity });
		}
		candidates.sort(
			(left, right) =>
				right.similarity - left.similarity ||
				((paths[left.j] ?? '') < (paths[right.j] ?? '') ? -1 : 1)
		);
		for (const { j } of candidates.slice(0, neighbors)) groups.union(i, j);
	}

	const components = new Map<number, Array<number>>();
	for (const [index] of items.entries()) {
		const root = groups.find(index);
		const bucket = components.get(root) ?? [];
		bucket.push(index);
		components.set(root, bucket);
	}

	const clusters: Array<Cluster> = [];
	const singletons: Array<string> = [];
	for (const members of components.values()) {
		if (members.length === 1) {
			const only = paths[members[0] ?? -1];
			singletons.push(only ?? '');
			continue;
		}
		clusters.push(clusterOf(members, similarities, items, paths, threshold));
	}

	const mutualNearest: Array<ClusterPair> = [];
	for (let i = 0; i < count; i += 1) {
		const row = similarities[i];
		if (row === undefined) continue;
		let best = -1;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let j = 0; j < count; j += 1) {
			const score = row[j];
			if (score !== undefined && score > bestScore && !Number.isNaN(score)) {
				best = j;
				bestScore = score;
			}
		}
		if (best <= i || bestScore < MIN_PARALLEL_SIMILARITY) continue;
		const back = similarities[best];
		if (back === undefined || back[i] !== bestScore) continue;
		const a = paths[i] ?? '';
		const b = paths[best] ?? '';
		if (a === b || a === '' || b === '') continue;
		mutualNearest.push({ a, b, similarity: bestScore });
	}

	mutualNearest.sort((left, right) =>
		left.a < right.a ? -1 : left.a > right.a ? 1
			: left.b < right.b ? -1 : left.b > right.b ? 1 : 0
	);

	clusters.sort((left, right) => {
		const leftFirst = left.members[0] ?? '';
		const rightFirst = right.members[0] ?? '';
		return leftFirst < rightFirst ? -1 : leftFirst > rightFirst ? 1 : 0;
	});
	singletons.sort();
	return { clusters, singletons, mutualNearest };
}
