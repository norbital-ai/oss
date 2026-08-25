/**
 * One root's semantic pass: refresh the index through the Merkle diff, cluster what the index
 * holds, and evaluate every pseudocode half the configuration declared.
 *
 * The tier is honest about three things. It runs or it throws — a missing credential is exit-2
 * evidence, never an all-clear. Its spend is measured, because an analysis that calls a paid API
 * owes its reader the bill (`IndexRunStats` rides out untouched). And its findings are
 * nominations: hints with `medium` confidence, consistent with the doctrine that deterministic
 * evidence decides while semantics nominates.
 *
 * Structural duplicates inside one package are already D1's territory; cross-package near-clones
 * are exactly the gap `SEM_TWIN` exists to fill, so no exemption machinery stands between them.
 */
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Finding } from '../index.js';
import type { Principle, Rule } from '../rules.js';
import type { LoadedConfig } from '../config.js';
import {
	clusterFilesDetailed,
	type ClusterItem
} from './cluster.js';
import { collectTwinCandidates, evaluateQueries, overlapFindings, TWIN_THRESHOLD } from './analyze.js';
import type { Cluster } from './cluster.js';
import type { IndexRunStats } from './embedder.js';
import { resolveEmbedder } from './provider/registry.js';
import { skeleton } from './skeleton.js';
import { refreshIndex } from './store.js';

type SemanticRun = Readonly<{
	/** False only when the configuration explicitly declined the tier. */
	readonly ran: boolean;
	readonly embedderId: string | undefined;
	/** The committed Merkle root — the digest a receipt can cite for "which vectors answered". */
	readonly indexDigest: string | undefined;
	readonly stats: IndexRunStats | undefined;
	/** What clustering found, for display and for the clusters artifact. */
	readonly clusterCount: number;
	readonly singletonCount: number;
	readonly findings: ReadonlyArray<Finding>;
}>;

const SEMANTIC_PRINCIPLES: ReadonlyArray<Principle> = ['modularity', 'colocation'];

/** Nearest ancestor directory with a package.json, repository-relative — a file's owner label. */
function createOwnerOf(root: string): (path: string) => string {
	const cache = new Map<string, string>();
	return (path: string): string => {
		const cached = cache.get(path);
		if (cached !== undefined) return cached;
		let directory = dirname(path);
		for (;;) {
			if (existsPackage(root, directory)) break;
			const parent = dirname(directory);
			if (parent === directory || directory === '.') {
				directory = '.';
				break;
			}
			directory = parent;
		}
		cache.set(path, directory);
		return directory;
	};
}

function existsPackage(root: string, directory: string): boolean {
	const read = Effect.runSync(
		Effect.result(Effect.try(() => readFileSync(join(root, directory === '.' ? '' : directory, 'package.json'))))
	);
	return Result.isSuccess(read);
}

/** The embedding text for one file: raw source reduced deterministically when oversized.
 *
 * Svelte keeps its markup on purpose — a component's responsibility lives in what it renders as
 * much as in what its script computes.
 */
function embedText(file: string, raw: string): string {
	return skeleton(file, raw);
}

type PairInspection = Readonly<{
	readonly exports: ReadonlyMap<string, number>;
	readonly specifiers: ReadonlyMap<string, ReadonlySet<string>>;
}>;

/**
 * Parallel pairs need real modules with real exported surfaces, and two modules whose texts
 * already reference each other are *linked*, not parallel: a contract and its implementation are
 * mutual nearest by design, and the pair closes through the import edge instead of through an
 * accident. The worker/vm case the signal exists for shares neither an export nor a specifier.
 */
function parallelEligible(inspected: PairInspection) {
	return (pair: { a: string; b: string }): boolean => {
		const exportA = inspected.exports.get(pair.a) ?? 0;
		const exportB = inspected.exports.get(pair.b) ?? 0;
		if (exportA < 3 || exportB < 3) return false;
		const refers = (from: string, to: string): boolean =>
			[...(inspected.specifiers.get(from) ?? [])].some((specifier) =>
				specifier.split('/').includes(stemOf(to))
			);
		return !refers(pair.a, pair.b) && !refers(pair.b, pair.a);
	};
}

const stemOf = (path: string): string => (path.split('/').pop() ?? '').replace(/\.[^.]+$/, '');

/** Parse the pair members only — a handful of files, not a sweep — for exports and specifiers. */
function inspectPairFiles(
	root: string,
	pairs: ReadonlyArray<{ a: string; b: string }>
): PairInspection {
	const wanted = new Set(pairs.flatMap((pair) => [pair.a, pair.b]));
	const exports = new Map<string, number>();
	const specifiers = new Map<string, ReadonlySet<string>>();
	for (const file of wanted) {
		const text = readFileSync(join(root, file), 'utf8');
		const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
		let exported = 0;
		const imports = new Set<string>();
		for (const statement of sourceFile.statements) {
			const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
			if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) exported += 1;
			if (
				ts.isImportDeclaration(statement) &&
				ts.isStringLiteral(statement.moduleSpecifier)
			)
				imports.add(statement.moduleSpecifier.text);
		}
		exports.set(file, exported);
		specifiers.set(file, imports);
	}
	return { exports, specifiers };
}

type SemanticTierOptions = Readonly<{
	readonly root: string;
	readonly config: LoadedConfig;
	readonly rules: ReadonlyArray<Rule>;
	readonly allFiles: ReadonlyArray<string>;
}>;

export async function runSemanticTier(options: SemanticTierOptions): Promise<SemanticRun> {
	const settings = options.config.semantic;
	if (settings === undefined || settings.disabled === true)
		return {
			ran: false,
			embedderId: undefined,
			indexDigest: undefined,
			stats: undefined,
			clusterCount: 0,
			singletonCount: 0,
			findings: []
		};

	const embedder = resolveEmbedder({
		provider: settings.provider ?? 'openrouter',
		model: settings.model,
		dimensions: settings.dimensions,
		credential: settings.credential,
		endpoint: settings.endpoint
	});

	// repository-health:allow NONDET1 -- wall-clock is what a bill is measured in; the receipt
	// records duration as elapsed time, not as a decision input.
	const started = Date.now();
	const files = new Map<string, { hash: string; text: string }>();
	for (const file of options.allFiles) {
		const read = Effect.runSync(
			Effect.result(Effect.try(() => readFileSync(join(options.root, file), 'utf8')))
		);
		if (Result.isFailure(read)) continue;
		const raw = Result.match(read, { onSuccess: (v) => v, onFailure: () => '' });
		files.set(file, {
			hash: createHash('sha256').update(raw).digest('hex'),
			text: embedText(file, raw)
		});
	}

	const refreshed = await refreshIndex({
		directory: join(options.root, '.norbital/diagnosis/index'),
		embedder,
		files
	});

	const items: Array<ClusterItem> = [...refreshed.vectors].map(([path, vector]) => ({
		path,
		vector,
		name: basename(path).replace(/\.[^.]+$/, '')
	}));
	const clusters = clusterFilesDetailed(items);
	const ownerOf = createOwnerOf(options.root);

	// Twins are not neighbors: two near-identical files in different packages usually have this
	// package's own cousins closer, so kNN edges alone starve the twin pass. The full upper
	// triangle is scanned once, at the twin threshold, and only those candidates join the pass.
	const twinCandidates = collectTwinCandidates(
		items,
		TWIN_THRESHOLD,
		new Set()
	);

	const findings: Array<Finding> = [];
	const inspected = inspectPairFiles(options.root, clusters.mutualNearest);
	for (const found of overlapFindings({
		clusters: clusters.clusters,
		ownerOf,
		twinCandidates,
		mutualNearest: clusters.mutualNearest.filter(
			(pair) =>
				ownerOf(pair.a) === ownerOf(pair.b) &&
				parallelEligible(inspected)(pair)
		)
	}))
		findings.push({
			severity: 'hint',
			confidence: 'medium',
			rule: found.rule,
			summary: found.summary,
			location: `${found.location}:1: ${found.evidence}`,
			principles: SEMANTIC_PRINCIPLES
		});

	const byId = new Map(options.rules.map((rule) => [rule.id, rule]));
	const hits = await evaluateQueries({
		queries: options.config.queries,
		vectors: refreshed.vectors,
		embedder
	});
	for (const hit of hits) {
		const rule = byId.get(hit.ruleId);
		if (rule === undefined) continue;
		findings.push({
			severity: rule.severity,
			confidence: rule.confidence ?? 'medium',
			rule: rule.id,
			summary: rule.summary,
			location: `${hit.path}:1: [semantic=${hit.similarity.toFixed(3)}]`,
			principles: [...rule.principles]
		});
	}

	// The clusters themselves are the tier's read-only inventory: written beside the receipt so a
	// person or an agent can navigate what was found without re-running embeddings.
	writeClusters(options.root, clusters.clusters, clusters.singletons);

	const order: Readonly<Record<string, number>> = { error: 0, hint: 1 };
	findings.sort(
		(left, right) =>
			(order[left.severity] ?? 9) - (order[right.severity] ?? 9) ||
			left.rule.localeCompare(right.rule) ||
			left.location.localeCompare(right.location)
	);

	return {
		ran: true,
		embedderId: embedder.id,
		indexDigest: refreshed.root,
				// repository-health:allow NONDET1 -- elapsed wall time, same reason as the measurement above.
		stats: { ...refreshed.stats, durationMs: Date.now() - started },
		clusterCount: clusters.clusters.length,
		singletonCount: clusters.singletons.length,
		findings
	};
}

/** The clusters inventory: deterministic fields only, atomic write, beside the receipt. */
function writeClusters(
	root: string,
	clusters: ReadonlyArray<Cluster>,
	singletons: ReadonlyArray<string>
): void {
	const directory = join(root, '.norbital/diagnosis');
	mkdirSync(directory, { recursive: true });
	const temporary = join(directory, `clusters.json.${process.pid}.tmp`);
	writeFileSync(
		temporary,
		`${JSON.stringify(
			{
				clusters: clusters.map((cluster) => ({
					label: cluster.label,
					members: cluster.members,
					similarity: Number(cluster.similarity.toFixed(3)),
					pairs: cluster.pairs
				})),
				singletons
			},
			null,
			2
		)}
`
	);
	renameSync(temporary, join(directory, 'clusters.json'));
}
