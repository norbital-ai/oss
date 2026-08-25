/**
 * Report assembly surfaces: schema constants, the serialized report shapes, the bounded markdown
 * decision briefs, and atomic publication, ported from `analyze.mjs`.
 *
 * The JSON report is a byte-level contract — key order is insertion order, distributions are
 * pre-rounded, and nothing here may add or reorder a field without a schema bump. The markdown
 * brief is deliberately lossy: it exists so a human can decide whether to open the JSON.
 */
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import type { Comparison } from './composite.js';
import type { Distribution } from './composite.js';
import type { DuplicateGroup, OverlapPair, FunctionalityCluster } from './entities.js';
import type { InlineCandidate, LocalityCounts, PillarReport } from './structure.js';
import type { Principle, StaticQualityBase } from './authenticate.js';
import type { RootDescription } from './inventory.js';

export const SCHEMA_VERSION = 9;
export const ANALYZER_VERSION = 10;

/** The seven composite scores; static quality and health stay null without scanner evidence. */
export type ScoreName =
	| 'coupling'
	| 'modularity'
	| 'colocation'
	| 'testability'
	| 'simplicity'
	| 'staticQuality'
	| 'health';

export type Scores = Record<ScoreName, number | null>;

/** Every counter the snapshot totals expose, in serialization order. */
export type ReportTotals = Readonly<{
	files: number;
	productionFiles: number;
	testFiles: number;
	unconfiguredTestFiles: number;
	physicalLoc: number;
	codeLoc: number;
	productionCodeLoc: number;
	testCodeLoc: number;
	unconfiguredTestCodeLoc: number;
	commentLoc: number;
	blankLoc: number;
	concepts: number;
	pillars: number;
	services: number;
	functions: number;
	codeEntities: number;
	passThroughFunctions: number;
	inlineCandidates: number;
	highConfidenceInlineCandidates: number;
	reviewInlineCandidates: number;
	transparentForwarders: number;
	callbackProxies: number;
	singleUseExpressions: number;
	sameFileNamedCalls: number;
	internalImportEdges: number;
	crossConceptEdges: number;
	externalImports: number;
	unresolvedInternalImports: number;
	cyclicModules: number;
	cycleGroups: number;
	duplicatePathwayGroups: number;
	duplicatePathwayOccurrences: number;
	overlappingPathwayPairs: number;
	functionalityClusters: number;
	crossConceptFunctionalityClusters: number;
	crossPillarFunctionalityClusters: number;
	clusteredEntityOccurrences: number;
	testReachedProductionModules: number;
	staticErrors: number | null;
	staticWarnings: number | null;
}>;

/** What the analyzer can prove about scanner coverage of one consolidated run. */
export type QualityCoverage = Readonly<{
	productionFiles: number;
	unscannedProductionFiles: number;
	unscannedFiles: ReadonlyArray<string>;
	tiers: Readonly<{ syntactic: boolean; graph: boolean; typeAware: boolean }>;
	rootsWithoutTypeAware: ReadonlyArray<string>;
	productionCodeLoc?: number;
}>;

/** The authenticated static-quality section, as it appears in a finished report. */
export type StaticQuality = Omit<StaticQualityBase, 'byPrinciple'> & {
	readonly byPrinciple: ReadonlyArray<{
		name: Principle;
		count: number;
		perThousandProductionLoc?: number | null;
	}>;
	readonly coverage?: QualityCoverage;
};

/** A concept aggregate, in serialization order. */
export type ConceptReport = Readonly<{
	concept: string;
	files: number;
	codeLoc: number;
	functions: number;
	services: ReadonlyArray<{ name: string; file: string }>;
	fanInConcepts: number;
	fanOutConcepts: number;
}>;

/** A service declaration attributed to its concept. */
export type ServiceReport = Readonly<{ name: string; file: string; concept: string }>;

/** The complete health snapshot, in top-level serialization order. */
export type HealthReport = Readonly<{
	schemaVersion: number;
	analyzerVersion: number;
	roots: ReadonlyArray<RootDescription>;
	totals: ReportTotals;
	scores: Scores;
	scorePrecision: Scores;
	quality: StaticQuality | null;
	distributions: Readonly<{
		productionFileCodeLoc: Distribution;
		functionCyclomatic: Distribution;
		functionNesting: Distribution;
		fanIn: Distribution;
		fanOut: Distribution;
		pillarCodeLoc: Distribution;
		pillarCohesion: Distribution;
		pillarComplexityDensity: Distribution;
		pillarIndirectionDensity: Distribution;
	}>;
	colocation: Readonly<{
		importEdges: LocalityCounts;
		importScore: number;
		sameFileNamedCalls: number;
	}>;
	concepts: ReadonlyArray<ConceptReport>;
	pillars: ReadonlyArray<PillarReport>;
	services: ReadonlyArray<ServiceReport>;
	cycles: ReadonlyArray<ReadonlyArray<string>>;
	duplicatePathways: ReadonlyArray<DuplicateGroup>;
	overlappingPathways: ReadonlyArray<OverlapPair>;
	functionalityClusters: ReadonlyArray<FunctionalityCluster>;
	inlineCandidates: ReadonlyArray<InlineCandidate>;
	hotspots: ReadonlyArray<{
		file: string;
		concept: string;
		codeLoc: number;
		fanIn: number;
		fanOut: number;
		p95Complexity: number;
	}>;
	comparison?: Comparison;
	verdict?: string;
}>;

/** The reduced overlap-only snapshot. */
export type OverlapReport = Readonly<{
	schemaVersion: number;
	analyzerVersion: number;
	mode: 'overlap-only';
	roots: ReadonlyArray<RootDescription>;
	verdict: 'findings' | 'pass';
	totals: Readonly<{
		productionFiles: number;
		codeEntities: number;
		duplicatePathwayGroups: number;
		duplicatePathwayOccurrences: number;
		overlappingPathwayPairs: number;
		functionalityClusters: number;
		crossConceptFunctionalityClusters: number;
		crossPillarFunctionalityClusters: number;
		clusteredEntityOccurrences: number;
	}>;
	duplicatePathways: ReadonlyArray<DuplicateGroup>;
	overlappingPathways: ReadonlyArray<OverlapPair>;
	functionalityClusters: ReadonlyArray<FunctionalityCluster>;
}>;

/** Render the bounded decision brief; exact evidence remains in JSON. */
export function markdown(report: HealthReport): string {
	const staticTiers = report.quality
		? [
				'syntactic',
				...(report.quality.coverage?.tiers.graph ? ['graph'] : []),
				...(report.quality.coverage?.tiers.typeAware ? ['type-aware'] : [])
			].join(' + ')
		: '';
	const lines = [
		'# Repository health',
		'',
		`Verdict: **${report.verdict}**`,
		'',
		report.quality
			? `Tiers: ${staticTiers}${!report.quality.coverage?.tiers.graph ? ' only — **graph rules not run**, so reachability, dead exports, and cycles are unevaluated' : !report.quality.coverage?.tiers.typeAware ? ' only — **type-aware not run**, so LEGACY2 and every other type-resolved rule is unevaluated' : ''}`
			: 'Tiers: no static evidence',
		'',
		'## Snapshot',
		'',
		'| Metric | Value |',
		'| --- | ---: |'
	];
	for (const [label, value] of [
		['Production files', report.totals.productionFiles],
		['Configured test files', report.totals.testFiles],
		['Unconfigured test files', report.totals.unconfiguredTestFiles],
		['Production code LOC', report.totals.productionCodeLoc],
		['Test code LOC', report.totals.testCodeLoc],
		['Unconfigured test code LOC', report.totals.unconfiguredTestCodeLoc],
		['Comment LOC (excluded)', report.totals.commentLoc],
		['Concepts', report.totals.concepts],
		['Pillars', report.totals.pillars],
		['Services', report.totals.services],
		['Named code entities', report.totals.codeEntities],
		['Internal edges', report.totals.internalImportEdges],
		['Unresolved internal imports', report.totals.unresolvedInternalImports],
		['Cross-concept edges', report.totals.crossConceptEdges],
		['Cyclic modules', report.totals.cyclicModules],
		['Duplicate entity groups', report.totals.duplicatePathwayGroups],
		['Overlapping entity pairs', report.totals.overlappingPathwayPairs],
		['Functionality clusters', report.totals.functionalityClusters],
		['Cross-concept functionality clusters', report.totals.crossConceptFunctionalityClusters],
		['Cross-pillar functionality clusters', report.totals.crossPillarFunctionalityClusters],
		['Inline candidates', report.totals.inlineCandidates],
		['High-confidence inline candidates', report.totals.highConfidenceInlineCandidates],
		['Review-only inline candidates', report.totals.reviewInlineCandidates],
		['Same-file named calls', report.totals.sameFileNamedCalls],
		['Pass-through functions', report.totals.passThroughFunctions]
	])
		lines.push(`| ${label} | ${value} |`);
	lines.push(
		'',
		'## Scores',
		'',
		'| Coupling ↓ | Modularity ↑ | Colocation ↑ | Testability ↑ | Simplicity ↑ | Static quality ↑ | Health ↑ |',
		'| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
		`| ${report.scores.coupling} | ${report.scores.modularity} | ${report.scores.colocation} | ${report.scores.testability} | ${report.scores.simplicity} | ${report.scores.staticQuality ?? 'not scanned'} | ${report.scores.health ?? 'not scored'} |`
	);
	if (report.quality) {
		lines.push(
			'',
			`Static findings: ${report.quality.totals.error} errors, ${report.quality.totals.warning} warnings, ${report.quality.totals.hint} hints.`,
			'',
			'## Findings by principle',
			'',
			'| Principle | Findings | Per 1,000 production LOC |',
			'| --- | ---: | ---: |'
		);
		for (const item of report.quality.byPrinciple)
			lines.push(`| ${item.name} | ${item.count} | ${item.perThousandProductionLoc ?? 'n/a'} |`);
		lines.push('', '## Largest static-debt rules', '', '| Rule | Findings |', '| --- | ---: |');
		for (const item of report.quality.byRule.slice(0, 15))
			lines.push(`| ${item.name} | ${item.count} |`);
	}
	if (report.comparison)
		lines.push(
			'',
			`Baseline regressions: ${report.comparison.regressions.length === 0 ? 'none' : report.comparison.regressions.join(', ')}`
		);
	lines.push(
		'',
		'## Largest concepts',
		'',
		'| Concept | Code LOC | Files | Services | Concept fan-in | Concept fan-out |',
		'| --- | ---: | ---: | ---: | ---: | ---: |'
	);
	for (const concept of report.concepts.slice(0, 20))
		lines.push(
			`| ${concept.concept} | ${concept.codeLoc} | ${concept.files} | ${concept.services.length} | ${concept.fanInConcepts} | ${concept.fanOutConcepts} |`
		);
	lines.push(
		'',
		'## Domain pillars',
		'',
		'| Pillar | LOC | Files | Child concepts | Cohesion | Colocation | Complexity/1k LOC | Inline high/review |',
		'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
	);
	for (const pillar of report.pillars.slice(0, 25))
		lines.push(
			`| ${pillar.label} | ${pillar.codeLoc} | ${pillar.files.length} | ${pillar.concepts.length} | ${(pillar.cohesion * 100).toFixed(1)}% | ${pillar.colocation.importScore} | ${pillar.complexity.excessPerThousandLoc} | ${pillar.indirection.highConfidence}/${pillar.indirection.review} |`
		);
	lines.push(
		'',
		'## Highest-LOC modules',
		'',
		'| File | Concept | Code LOC | Fan-in | Fan-out | p95 complexity |',
		'| --- | --- | ---: | ---: | ---: | ---: |'
	);
	for (const item of report.hotspots.slice(0, 15))
		lines.push(
			`| ${item.file} | ${item.concept} | ${item.codeLoc} | ${item.fanIn} | ${item.fanOut} | ${item.p95Complexity} |`
		);
	if (report.functionalityClusters.length) {
		lines.push(
			'',
			'## Functionality clusters',
			'',
			'| Label | Members | Pillars | Cyclomatic p95 | Excess | Pass-through | Same-pillar | Density |',
			'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
		);
		for (const cluster of report.functionalityClusters.slice(0, 20))
			lines.push(
				`| ${cluster.label} | ${cluster.members.length} | ${cluster.pillars.length} | ${cluster.complexity.cyclomatic.p95} | ${cluster.complexity.excessCyclomatic} | ${cluster.indirection.passThroughMembers} | ${(cluster.colocation.samePillarShare * 100).toFixed(1)}% | ${(cluster.overlapDensity * 100).toFixed(1)}% |`
			);
	}
	lines.push(
		'',
		`Cycles: ${report.totals.cycleGroups}. Exact duplicate groups: ${report.totals.duplicatePathwayGroups}. High-confidence overlap pairs: ${report.totals.overlappingPathwayPairs}. Read the JSON report for exact evidence.`,
		''
	);
	return lines.join('\n');
}

/** Render the overlap-only brief. */
export function overlapMarkdown(report: OverlapReport): string {
	const lines: Array<string> = [
		'# Functionality overlap',
		'',
		`Verdict: **${report.verdict}**.`,
		'',
		`Scanned ${report.totals.productionFiles} production files and ${report.totals.codeEntities} named functions, methods, constructors/accessors, and classes.`,
		`Exact duplicate groups: ${report.totals.duplicatePathwayGroups}. High-confidence overlapping pairs: ${report.totals.overlappingPathwayPairs}. Functionality clusters: ${report.totals.functionalityClusters}.`
	];
	if (report.functionalityClusters.length) {
		lines.push(
			'',
			'## Functionality clusters',
			'',
			'| Label | Members | Pillars | Complexity p95 | Excess complexity | Pass-through | Same-pillar | Density |',
			'| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
		);
		for (const cluster of report.functionalityClusters.slice(0, 30))
			lines.push(
				`| ${cluster.label} | ${cluster.members.length} | ${cluster.pillars.length} | ${cluster.complexity.cyclomatic.p95} | ${cluster.complexity.excessCyclomatic} | ${cluster.indirection.passThroughMembers} | ${(cluster.colocation.samePillarShare * 100).toFixed(1)}% | ${(cluster.overlapDensity * 100).toFixed(1)}% |`
			);
	}
	if (report.overlappingPathways.length) {
		lines.push(
			'',
			'## Overlapping functionality',
			'',
			'| Similarity | Left | Right |',
			'| ---: | --- | --- |'
		);
		for (const item of report.overlappingPathways.slice(0, 50))
			lines.push(
				`| ${(item.similarity * 100).toFixed(1)}% | ${item.left.file}:${item.left.line} (${item.left.entity}) | ${item.right.file}:${item.right.line} (${item.right.entity}) |`
			);
	}
	return lines.join('\n');
}

/** Atomically publish one output file; JSON and Markdown are not a transactional pair. */
export function atomicWrite(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, content);
	renameSync(temporary, path);
}

/** Normalize an explicit single-format extension when one path names a JSON/Markdown pair. */
export function pairedOutputRoot(path: string): string {
	return path.replace(/\.(?:json|md)$/i, '');
}
