/**
 * Ownership structure: concepts, pillars, and physical import locality.
 *
 * A concept is a repeatable path proxy — the first two directories below the first `src/` segment,
 * qualified by package identity — and a pillar groups a package's child concepts under their first
 * owned directory. Neither guesses from comments or embeddings. Locality classes order an edge by
 * physical distance from same directory to cross-root; the weighted score built on top is
 * display-only colocation evidence and never feeds the health composite.
 */
import { createHash } from 'node:crypto';
import { dirname, relative, sep } from 'node:path';
import { distribution, roundedRatio } from './composite.js';
import type { Distribution } from './composite.js';
import type { PackageOwner } from './graph.js';
import type { LineCounts } from './inventory.js';

/** Everything locality classification needs to know about one endpoint of an edge. */
export type LocalityRef = Readonly<{
	root: Readonly<{ id: string }>;
	owner: Readonly<{ id: string }>;
	path: string;
	concept: string;
	pillar: string;
}>;

/** Per-function complexity facts pillars aggregate. */
export type FunctionMetric = Readonly<{
	name: string;
	line: number;
	cyclomatic: number;
	nesting: number;
	passThrough: boolean;
}>;

/** One candidate inline opportunity attributed to its owning file. */
export type InlineCandidate = Readonly<{
	name: string;
	line: number | null;
	useLine: number | null;
	kind: string;
	confidence: string;
	forwardsTo?: string;
	tokens: number | null;
	file: string | null;
	concept: string;
	pillar: string;
}>;

/** The slice of a static-finding catalogue pillars need: findings keyed by display path. */
export type PillarQualityView = Readonly<{
	findings: ReadonlyArray<{ file: string | null }>;
}>;

/** The slice of an analyzed file that pillar construction reads. */
export type PillarFileRecord = LocalityRef & {
	displayPath: string;
	owner: PackageOwner;
	lines: LineCounts;
	services: ReadonlyArray<string>;
	functions: ReadonlyArray<FunctionMetric>;
	namedFunctions: number;
	codeEntities: number;
	localNamedCalls: number;
};

/** Derive a stable concept from package ownership and the first two directories below src. */
export function conceptFor(path: string, owner: PackageOwner): string {
	const parts = relative(owner.root, path).split(sep);
	const sourceIndex = parts.indexOf('src');
	const owned = sourceIndex >= 0 ? parts.slice(sourceIndex + 1, -1) : parts.slice(0, 1);
	const concept = owned.slice(0, 2).join('/') || 'root';
	return `${owner.id}:${concept}`;
}

/** Group child concepts beneath the first owned source directory: one deterministic domain pillar. */
export function pillarFor(path: string, owner: PackageOwner): string {
	const parts = relative(owner.root, path).split(sep);
	const sourceIndex = parts.indexOf('src');
	const owned = sourceIndex >= 0 ? parts.slice(sourceIndex + 1, -1) : parts.slice(0, -1);
	return `${owner.id}:${owned[0] ?? 'root'}`;
}

export const LOCALITY_WEIGHTS = {
	sameDirectory: 1,
	parentChild: 0.9,
	sameConcept: 0.75,
	samePillar: 0.6,
	samePackage: 0.35,
	crossPackage: 0.1,
	crossRoot: 0
} as const;

export type LocalityCounts = Record<keyof typeof LOCALITY_WEIGHTS, number>;

export function emptyLocality(): LocalityCounts {
	return Object.fromEntries(
		Object.keys(LOCALITY_WEIGHTS).map((name) => [name, 0])
	) as LocalityCounts;
}

function isDirectoryAncestor(parent: string, child: string): boolean {
	return parent !== child && child.startsWith(`${parent}${sep}`);
}

/** Classify a resolved module edge by physical ownership distance. */
export function importLocality(from: LocalityRef, target: LocalityRef): keyof LocalityCounts {
	if (from.root.id !== target.root.id) return 'crossRoot';
	if (from.owner.id !== target.owner.id) return 'crossPackage';
	const fromDirectory = dirname(from.path);
	const targetDirectory = dirname(target.path);
	if (fromDirectory === targetDirectory) return 'sameDirectory';
	if (
		isDirectoryAncestor(fromDirectory, targetDirectory) ||
		isDirectoryAncestor(targetDirectory, fromDirectory)
	)
		return 'parentChild';
	if (from.concept === target.concept) return 'sameConcept';
	if (from.pillar === target.pillar) return 'samePillar';
	return 'samePackage';
}

export function localityScore(counts: LocalityCounts): number {
	const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
	if (total === 0) return 100;
	const weighted = Object.entries(counts).reduce(
		(sum, [name, count]) => sum + LOCALITY_WEIGHTS[name as keyof typeof LOCALITY_WEIGHTS] * count,
		0
	);
	return Math.round((100 * weighted * 1_000_000) / total) / 1_000_000;
}

/** A finished pillar record, serialized into the report in exactly this key order. */
export type PillarReport = Readonly<{
	id: string;
	pillar: string;
	name: string;
	label: string;
	package: string;
	packageName: string;
	files: ReadonlyArray<string>;
	concepts: ReadonlyArray<string>;
	codeLoc: number;
	services: number;
	functions: number;
	namedFunctions: number;
	codeEntities: number;
	cyclicModules: number;
	complexity: Readonly<{
		cyclomatic: Distribution;
		nesting: Distribution;
		excessCyclomatic: number;
		excessPerThousandLoc: number;
	}>;
	cohesion: number;
	edges: Readonly<{ internal: number; inbound: number; outbound: number; boundary: number }>;
	colocation: Readonly<{
		sameFileNamedCalls: number;
		imports: LocalityCounts;
		importScore: number;
	}>;
	indirection: Readonly<{
		inlineCandidates: number;
		highConfidence: number;
		review: number;
		transparentForwarders: number;
		callbackProxies: number;
		singleUseExpressions: number;
		perHundredNamedFunctions: number;
		candidates: ReadonlyArray<InlineCandidate>;
	}>;
	staticFindings: number;
}>;

/** Aggregate path-owned child concepts into deterministic domain pillars. */
export function buildPillars(
	production: ReadonlyArray<PillarFileRecord>,
	productionAdjacency: ReadonlyMap<string, ReadonlySet<string>>,
	byPath: ReadonlyMap<string, PillarFileRecord>,
	cycles: ReadonlyArray<ReadonlyArray<string>>,
	quality: PillarQualityView | null,
	inlineCandidates: ReadonlyArray<InlineCandidate>
): Array<PillarReport> {
	type MutablePillar = {
		pillar: string;
		name: string;
		label: string;
		package: string;
		packageName: string;
		files: Array<string>;
		concepts: Set<string>;
		codeLoc: number;
		services: number;
		functions: Array<FunctionMetric>;
		namedFunctions: number;
		codeEntities: number;
		cyclicModules: number;
		localNamedCalls: number;
		inlineCandidates: Array<InlineCandidate>;
		internalEdges: number;
		inboundEdges: number;
		outboundEdges: number;
		locality: LocalityCounts;
	};
	const map = new Map<string, MutablePillar>();
	const cycleModules = new Set(cycles.flat());
	for (const record of production) {
		const name = record.pillar.slice(record.owner.id.length + 1);
		const current =
			map.get(record.pillar) ?? {
				pillar: record.pillar,
				name,
				label: `${record.owner.name}:${name}`,
				package: record.owner.id,
				packageName: record.owner.name,
				files: [],
				concepts: new Set<string>(),
				codeLoc: 0,
				services: 0,
				functions: [],
				namedFunctions: 0,
				codeEntities: 0,
				cyclicModules: 0,
				localNamedCalls: 0,
				inlineCandidates: [],
				internalEdges: 0,
				inboundEdges: 0,
				outboundEdges: 0,
				locality: emptyLocality()
			};
		current.files.push(record.displayPath);
		current.concepts.add(record.concept);
		current.codeLoc += record.lines.code;
		current.services += record.services.length;
		current.functions.push(...record.functions);
		current.namedFunctions += record.namedFunctions;
		current.codeEntities += record.codeEntities;
		current.cyclicModules += cycleModules.has(record.path) ? 1 : 0;
		current.localNamedCalls += record.localNamedCalls;
		map.set(record.pillar, current);
	}
	for (const candidate of inlineCandidates)
		if (map.has(candidate.pillar)) map.get(candidate.pillar)?.inlineCandidates.push(candidate);
	for (const [from, targets] of productionAdjacency) {
		const source = byPath.get(from);
		if (!source) continue;
		for (const targetPath of targets) {
			const target = byPath.get(targetPath);
			if (!target) continue;
			const sourcePillar = map.get(source.pillar);
			if (!sourcePillar || !map.has(target.pillar)) continue;
			sourcePillar.locality[importLocality(source, target)] += 1;
			if (source.pillar === target.pillar) sourcePillar.internalEdges += 1;
			else {
				sourcePillar.outboundEdges += 1;
				const targetPillar = map.get(target.pillar);
				if (targetPillar) targetPillar.inboundEdges += 1;
			}
		}
	}
	const findingCounts = new Map<string, number>();
	for (const finding of quality?.findings ?? [])
		if (finding.file)
			findingCounts.set(finding.file, (findingCounts.get(finding.file) ?? 0) + 1);
	return [...map.values()]
		.map((pillar): PillarReport => {
			const cyclomatic = pillar.functions.map(({ cyclomatic }) => cyclomatic);
			const nesting = pillar.functions.map(({ nesting }) => nesting);
			const excessCyclomatic = cyclomatic.reduce(
				(sum, complexity) => sum + Math.max(0, complexity - 1),
				0
			);
			const boundaryEdges = pillar.inboundEdges + pillar.outboundEdges;
			const candidates = pillar.inlineCandidates.sort(
				(left, right) =>
					(left.file ?? '').localeCompare(right.file ?? '') ||
					(left.line ?? 0) - (right.line ?? 0) ||
					left.name.localeCompare(right.name)
			);
			return {
				id: createHash('sha256').update(pillar.pillar).digest('hex').slice(0, 12),
				pillar: pillar.pillar,
				name: pillar.name,
				label: pillar.label,
				package: pillar.package,
				packageName: pillar.packageName,
				files: pillar.files.sort(),
				concepts: [...pillar.concepts].sort(),
				codeLoc: pillar.codeLoc,
				services: pillar.services,
				functions: pillar.functions.length,
				namedFunctions: pillar.namedFunctions,
				codeEntities: pillar.codeEntities,
				cyclicModules: pillar.cyclicModules,
				complexity: {
					cyclomatic: distribution(cyclomatic),
					nesting: distribution(nesting),
					excessCyclomatic,
					excessPerThousandLoc: roundedRatio(excessCyclomatic, pillar.codeLoc, 1_000)
				},
				cohesion: roundedRatio(2 * pillar.internalEdges, 2 * pillar.internalEdges + boundaryEdges),
				edges: {
					internal: pillar.internalEdges,
					inbound: pillar.inboundEdges,
					outbound: pillar.outboundEdges,
					boundary: boundaryEdges
				},
				colocation: {
					sameFileNamedCalls: pillar.localNamedCalls,
					imports: pillar.locality,
					importScore: localityScore(pillar.locality)
				},
				indirection: {
					inlineCandidates: candidates.length,
					highConfidence: candidates.filter(({ confidence }) => confidence === 'high').length,
					review: candidates.filter(({ confidence }) => confidence === 'review').length,
					transparentForwarders: candidates.filter(({ kind }) => kind === 'transparent-forwarder')
						.length,
					callbackProxies: candidates.filter(({ kind }) => kind === 'callback-proxy').length,
					singleUseExpressions: candidates.filter(({ kind }) => kind === 'single-use-expression')
						.length,
					perHundredNamedFunctions: roundedRatio(
						candidates.length,
						pillar.namedFunctions,
						100
					),
					candidates
				},
				staticFindings: pillar.files.reduce(
					(sum, file) => sum + (findingCounts.get(file) ?? 0),
					0
				)
			};
		})
		.sort((left, right) => right.codeLoc - left.codeLoc || left.pillar.localeCompare(right.pillar));
}
