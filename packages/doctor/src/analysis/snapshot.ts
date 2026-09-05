import { readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Option, Schema } from 'effect';
import { LANGUAGE_HEALTH_PROFILE, type HealthProfile } from '../health-profile.js';
import { collectSourceFiles, describeRoots, isTestPath, lineCounts } from './inventory.js';
import type { LineCounts, RootDescription } from './inventory.js';
import { moduleMappings, packageFor, resolveImport, stronglyConnected, testReach } from './graph.js';
import type { PackageOwner } from './graph.js';
import {
	buildPillars,
	conceptFor,
	emptyLocality,
	importLocality,
	localityScore,
	pillarFor
} from './structure.js';
import type { FunctionMetric, InlineCandidate, PillarReport } from './structure.js';
import { isConfiguredTest } from './tests-config.js';
import { analyzeAst } from './complexity.js';
import type { AstSummary, ImportEdge } from './complexity.js';
import { pathwayEvidence } from './entities.js';
import type {
	DuplicateGroup,
	FunctionalityCluster,
	OverlapPair,
	PathwayEntity,
	PathwayEntityCore
} from './entities.js';
import { compare, distribution } from './composite.js';
import type { Comparison, ComparisonSide } from './composite.js';
import { scannerCatalogues, staticFindings } from './authenticate.js';
import type { Principle, StaticQualityBase } from './authenticate.js';
import {
	SCHEMA_VERSION,
	ANALYZER_VERSION,
	atomicWrite,
	markdown,
	overlapMarkdown,
	pairedOutputRoot
} from './report.js';
import type {
	ConceptReport,
	HealthReport,
	OverlapReport,
	Scores,
	ServiceReport
} from './report.js';

type FileRecord = {
	path: string;
	displayPath: string;
	root: RootDescription;
	owner: PackageOwner;
	concept: string;
	pillar: string;
	test: boolean;
	configuredTest: boolean;
	lines: LineCounts;
	imports: ReadonlyArray<ImportEdge>;
	functions: Array<FunctionMetric>;
	namedFunctions: number;
	namedPassThroughFunctions: number;
	inlineCandidates: AstSummary['inlineCandidates'];
	localNamedCalls: number;
	duplicateEntities: ReadonlyArray<PathwayEntityCore>;
	codeEntities: number;
	services: ReadonlyArray<string>;
};

type WorkingQuality = {
	catalogues: StaticQualityBase['catalogues'];
	totals: StaticQualityBase['totals'];
	byRule: StaticQualityBase['byRule'];
	byPrinciple: Array<{
		name: Principle;
		count: number;
		perThousandProductionLoc?: number | null;
	}>;
	byConcept: StaticQualityBase['byConcept'];
	findings: StaticQualityBase['findings'];
	coverage?: {
		productionFiles: number;
		unscannedProductionFiles: number;
		unscannedFiles: Array<string>;
		tiers: { syntactic: boolean; graph: boolean; typeAware: boolean };
		rootsWithoutTypeAware: Array<string>;
		productionCodeLoc?: number;
	};
};

type Hotspot = {
	file: string;
	concept: string;
	codeLoc: number;
	fanIn: number;
	fanOut: number;
	p95Complexity: number;
};

type BuiltReport = Omit<HealthReport, 'quality' | 'comparison' | 'verdict'> & {
	quality: WorkingQuality | null;
	comparison?: Comparison;
	verdict?: string;
};

export type ReportFormat = 'json' | 'markdown' | 'both';

export type AssembleOptions = Readonly<{
	readonly roots: ReadonlyArray<string>;
	readonly receipts?: ReadonlyArray<string> | undefined;
	readonly baseline?: string | undefined;
	readonly out?: string | undefined;
	readonly format?: ReportFormat | undefined;
	readonly failOnRegression?: boolean | undefined;
	readonly requireTypeAware?: boolean | undefined;
	readonly overlapOnly?: boolean | undefined;
	readonly healthProfile?: HealthProfile | undefined;
}>;

export type AssembleResult = Readonly<{
	verdict: string;
	exitCode: number;
	stdout: string;
	json: string;
	brief: string;
	wrote: ReadonlyArray<string>;
}>;

type NormalizedOptions = Readonly<{
	roots: ReadonlyArray<string>;
	receipts: ReadonlyArray<string>;
	baseline: string | undefined;
	out: string | undefined;
	format: ReportFormat;
	failOnRegression: boolean;
	requireTypeAware: boolean;
	overlapOnly: boolean;
	healthProfile: HealthProfile;
}>;

function normalizeOptions(options: AssembleOptions): NormalizedOptions {
	const format = options.format ?? 'both';
	if (!['json', 'markdown', 'both'].includes(format))
		throw new Error('--format must be json, markdown, or both');
	const roots = [...new Set(options.roots.map((root) => realpathSync(root)))].sort();
	if (roots.length === 0) throw new Error('at least one --root is required');
	for (let index = 0; index < roots.length; index += 1)
		for (let other = index + 1; other < roots.length; other += 1) {
			const left = roots[index] ?? '';
			const right = roots[other] ?? '';
			if (right.startsWith(`${left}${sep}`))
				throw new Error(`selected roots overlap: ${left} contains ${right}`);
		}
	const receipts = [...new Set((options.receipts ?? []).map((path) => realpathSync(path)))].sort();
	const failOnRegression = options.failOnRegression === true;
	const overlapOnly = options.overlapOnly === true;
	if (failOnRegression && options.baseline === undefined)
		throw new Error('--fail-on-regression requires --baseline');
	if (
		overlapOnly &&
		(receipts.length > 0 || options.baseline !== undefined || failOnRegression)
	)
		throw new Error('--overlap-only does not accept receipts or baseline gates');
	return {
		roots,
		receipts,
		baseline: options.baseline,
		out: options.out,
		format,
		failOnRegression,
		requireTypeAware: options.requireTypeAware === true,
		overlapOnly,
		healthProfile: options.healthProfile ?? LANGUAGE_HEALTH_PROFILE
	};
}

const isRecordValue = Schema.is(Schema.Record(Schema.String, Schema.Unknown));
const isNumber = Schema.is(Schema.Number);

function numericFields(value: unknown): Record<string, number | null> {
	if (!isRecordValue(value)) return {};
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [
			key,
			entry === null ? null : isNumber(entry) ? entry : Number.NaN
		])
	);
}

const BaselineRecord = Schema.Struct({
	schemaVersion: Schema.optionalKey(Schema.Unknown),
	analyzerVersion: Schema.optionalKey(Schema.Unknown),
	roots: Schema.optionalKey(Schema.Unknown),
	scorePrecision: Schema.optionalKey(Schema.Unknown),
	totals: Schema.optionalKey(Schema.Unknown)
});

function decodeBaseline(text: string): ComparisonSide {
	// repository-health:allow R6b -- the parse becomes a schema decode on the next step.
	const parsed: unknown = JSON.parse(text);
	const decoded = Schema.decodeUnknownOption(BaselineRecord)(parsed);
	const record = Option.isSome(decoded) ? decoded.value : {};
	return {
		schemaVersion: record.schemaVersion,
		analyzerVersion: record.analyzerVersion,
		roots: record.roots,
		scorePrecision: numericFields(record.scorePrecision),
		totals: numericFields(record.totals)
	};
}

function publish(
	json: string,
	brief: string,
	format: ReportFormat,
	out: string | undefined,
	defaultPath: string
): { stdout: string; wrote: Array<string> } {
	const outputRoot = out ?? resolve(defaultPath);
	if (format === 'json' || format === 'markdown') {
		const body = format === 'json' ? json : brief;
		if (out) {
			atomicWrite(outputRoot, body);
			return { stdout: '', wrote: [outputRoot] };
		}
		return { stdout: body, wrote: [] };
	}
	const pairRoot = pairedOutputRoot(outputRoot);
	atomicWrite(`${pairRoot}.json`, json);
	atomicWrite(`${pairRoot}.md`, brief);
	return { stdout: brief, wrote: [`${pairRoot}.json`, `${pairRoot}.md`] };
}

export function assembleReport(options: AssembleOptions): AssembleResult {
	const normalized = normalizeOptions(options);
	if (normalized.overlapOnly) {
		const report = analyzeOverlaps(normalized.roots, normalized.healthProfile);
		const json = `${JSON.stringify(report, null, 2)}\n`;
		const brief = `${overlapMarkdown(report)}\n`;
		const { stdout, wrote } = publish(
			json,
			brief,
			normalized.format,
			normalized.out,
			'.norbital/diagnosis/overlap'
		);
		return {
			verdict: report.verdict,
			exitCode: report.verdict === 'findings' ? 1 : 0,
			stdout,
			json,
			brief,
			wrote
		};
	}
	const report = analyze(normalized.roots, normalized.receipts, normalized.healthProfile);
	if (normalized.baseline)
		report.comparison = compare(
			report,
			decodeBaseline(readFileSync(normalized.baseline, 'utf8'))
		);
	report.verdict =
		normalized.receipts.length === 0 ||
		(report.quality?.coverage?.unscannedProductionFiles ?? 0) > 0 ||
		(normalized.requireTypeAware && !(report.quality?.coverage?.tiers.typeAware ?? false))
			? 'incomplete'
			: ((report.quality?.totals.error ?? 0) + (report.quality?.totals.warning ?? 0) > 0
				? 'fail'
				: normalized.failOnRegression && (report.comparison?.regressions.length ?? 0) > 0
					? 'regression'
					: 'pass');
	const json = `${JSON.stringify(report, null, 2)}\n`;
	const brief = `${markdown(report as HealthReport)}\n`;
	const { stdout, wrote } = publish(
		json,
		brief,
		normalized.format,
		normalized.out,
		'.norbital/diagnosis/report'
	);
	const verdict = report.verdict ?? 'pass';
	return {
		verdict,
		exitCode: verdict === 'regression' || verdict === 'fail' ? 1 : verdict === 'incomplete' ? 2 : 0,
		stdout,
		json,
		brief,
		wrote
	};
}

function analyzeOverlaps(roots: ReadonlyArray<string>, profile: HealthProfile): OverlapReport {
	const files = collectSourceFiles(roots).filter((path) => !isTestPath(path));
	if (files.length === 0) throw new Error('selected zero production source files');
	const rootDescriptions = describeRoots(roots);
	const rootByPath = new Map(rootDescriptions.map((root) => [root.path, root]));
	const packageCache = new Map<string, PackageOwner>();
	const entities: Array<PathwayEntity> = [];
	for (const path of files) {
		const containingRoot =
			[...roots]
				.filter((root) => path === root || path.startsWith(`${root}${sep}`))
				.sort((a, b) => b.length - a.length)[0] ?? '';
		const root = rootByPath.get(containingRoot) ?? { path: containingRoot, id: containingRoot };
		const owner = packageFor(path, containingRoot, root.id, packageCache);
		const displayPath = `${root.id}/${relative(containingRoot, path).split(sep).join('/')}`;
		const concept = conceptFor(path, owner);
		const pillar = pillarFor(path, owner);
		for (const item of analyzeAst(path, readFileSync(path, 'utf8'), profile).duplicateEntities)
			entities.push({ ...item, file: displayPath, concept, pillar, rootId: root.id });
	}
	const pathways = pathwayEvidence(entities, profile.genericLabels);
	return {
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: ANALYZER_VERSION,
		mode: 'overlap-only',
		roots: rootDescriptions,
		verdict: pathways.exact.length || pathways.overlapping.length ? 'findings' : 'pass',
		totals: {
			productionFiles: files.length,
			codeEntities: entities.length,
			duplicatePathwayGroups: pathways.exact.length,
			duplicatePathwayOccurrences: pathways.exact.reduce(
				(sum, group) => sum + group.occurrences.length,
				0
			),
			overlappingPathwayPairs: pathways.overlapping.length,
			functionalityClusters: pathways.clusters.length,
			crossConceptFunctionalityClusters: pathways.clusters.filter(
				({ crossConcept }) => crossConcept
			).length,
			crossPillarFunctionalityClusters: pathways.clusters.filter(({ crossPillar }) => crossPillar)
				.length,
			clusteredEntityOccurrences: pathways.clusters.reduce(
				(sum, cluster) => sum + cluster.members.length,
				0
			)
		},
		duplicatePathways: pathways.exact,
		overlappingPathways: pathways.overlapping,
		functionalityClusters: pathways.clusters
	};
}

function analyze(
	roots: ReadonlyArray<string>,
	receiptPaths: ReadonlyArray<string>,
	profile: HealthProfile
): BuiltReport {
	const files = collectSourceFiles(roots);
	if (files.length === 0) throw new Error('selected zero source files');
	const rootDescriptions = describeRoots(roots);
	const rootByPath = new Map(rootDescriptions.map((root) => [root.path, root]));
	const packageCache = new Map<string, PackageOwner>();
	const records: Array<FileRecord> = files.map((path) => {
		const source = readFileSync(path, 'utf8');
		const containingRoot =
			[...roots]
				.filter((root) => path === root || path.startsWith(`${root}${sep}`))
				.sort((a, b) => b.length - a.length)[0] ?? '';
		const root = rootByPath.get(containingRoot) ?? { path: containingRoot, id: containingRoot };
		const owner = packageFor(path, containingRoot, root.id, packageCache);
		const localPath = relative(containingRoot, path).split(sep).join('/');
		const test = isTestPath(path);
		const ast = analyzeAst(path, source, profile);
		return {
			path,
			displayPath: `${root.id}/${localPath}`,
			root,
			owner,
			concept: conceptFor(path, owner),
			pillar: pillarFor(path, owner),
			test,
			configuredTest: test && isConfiguredTest(path, owner),
			lines: lineCounts(path, source),
			imports: ast.imports,
			functions: ast.functions,
			namedFunctions: ast.namedFunctions,
			namedPassThroughFunctions: ast.namedPassThroughFunctions,
			inlineCandidates: ast.inlineCandidates,
			localNamedCalls: ast.localNamedCalls,
			duplicateEntities: ast.duplicateEntities,
			codeEntities: ast.duplicateEntities.length,
			services: ast.services
		};
	});
	const fileSet = new Set(files);
	const packageByName = new Map<string, Array<PackageOwner>>();
	for (const owner of new Map(records.map((record) => [record.owner.id, record.owner])).values()) {
		const owners = packageByName.get(owner.name) ?? [];
		owners.push(owner);
		packageByName.set(
			owner.name,
			owners.sort((a, b) => a.id.localeCompare(b.id))
		);
	}
	const aliasesByRoot = new Map(
		[...new Map(records.map((record) => [record.owner.root, record.owner])).values()].map(
			(owner) => [owner.root, moduleMappings(owner)]
		)
	);
	const adjacency = new Map(files.map((file) => [file, new Set<string>()]));
	const valueAdjacency = new Map(files.map((file) => [file, new Set<string>()]));
	let externalImports = 0;
	let unresolvedInternalImports = 0;
	for (const record of records) {
		for (const imported of record.imports) {
			const resolution = resolveImport(
				record.path,
				imported.specifier,
				fileSet,
				packageByName,
				record.owner,
				aliasesByRoot
			);
			for (const target of resolution.targets) {
				adjacency.get(record.path)?.add(target);
				if (!imported.typeOnly) valueAdjacency.get(record.path)?.add(target);
			}
			if (resolution.targets.length === 0) {
				if (resolution.internal) unresolvedInternalImports += 1;
				else externalImports += 1;
			}
		}
	}
	const production = records.filter((record) => !record.test);
	const testCandidates = records.filter((record) => record.test);
	const tests = testCandidates.filter((record) => record.configuredTest);
	const productionSet = new Set(production.map((record) => record.path));
	const productionAdjacency = new Map(
		production.map((record) => [
			record.path,
			new Set([...(adjacency.get(record.path) ?? [])].filter((target) => productionSet.has(target)))
		])
	);
	const incoming = new Map(production.map((record) => [record.path, 0]));
	let internalEdges = 0;
	let crossConceptEdges = 0;
	const importLocalities = emptyLocality();
	const byPath = new Map(records.map((record) => [record.path, record]));
	const catalogues =
		receiptPaths.length > 0 ? scannerCatalogues(receiptPaths, roots) : null;
	const quality: WorkingQuality | null = catalogues ? staticFindings(catalogues, byPath, rootByPath) : null;
	if (quality && catalogues) {
		const covered = new Set(
			catalogues.flatMap(({ receipt, inventory }) =>
				inventory.sources.map((file) => join(receipt.root, file))
			)
		);
		const unscanned = production.filter((record) => !covered.has(record.path));
		quality.coverage = {
			productionFiles: production.length - unscanned.length,
			unscannedProductionFiles: unscanned.length,
			unscannedFiles: unscanned.map((record) => record.displayPath).sort(),
			tiers: {
				syntactic: true,
				graph: catalogues.every(({ receipt }) => receipt.tiers.graph),
				typeAware: catalogues.every(({ receipt }) => receipt.tiers.typeAware)
			},
			rootsWithoutTypeAware: catalogues
				.filter(({ receipt }) => !receipt.tiers.typeAware)
				.map(({ receipt }) => receipt.root)
				.sort()
		};
	}
	for (const [from, targets] of productionAdjacency)
		for (const target of targets) {
			internalEdges += 1;
			incoming.set(target, (incoming.get(target) ?? 0) + 1);
			const source = byPath.get(from);
			const destination = byPath.get(target);
			if (source && destination) {
				importLocalities[importLocality(source, destination)] += 1;
				if (source.concept !== destination.concept) crossConceptEdges += 1;
			}
		}
	const cycles = stronglyConnected(productionSet, productionAdjacency);
	const cyclicModules = new Set(cycles.flat()).size;
	const fanOut = production.map((record) => (productionAdjacency.get(record.path) ?? new Set()).size);
	const fanIn = production.map((record) => incoming.get(record.path) ?? 0);
	const fanOutStats = distribution(fanOut);
	const topHubCount = Math.max(1, Math.ceil(production.length * 0.1));
	const hubShare =
		internalEdges === 0
			? 0
			: [...fanIn]
						.sort((a, b) => b - a)
						.slice(0, topHubCount)
						.reduce((sum, value) => sum + value, 0) / internalEdges;
	const coupling =
		100 *
		(0.4 * (crossConceptEdges / Math.max(internalEdges, 1)) +
			0.3 * (cyclicModules / Math.max(production.length, 1)) +
			0.2 * Math.min(1, fanOutStats.p95 / Math.sqrt(Math.max(production.length, 1))) +
			0.1 * hubShare);
	const functions = production.flatMap((record) =>
		record.functions.map((item) => ({
			...item,
			file: record.displayPath,
			concept: record.concept,
			pillar: record.pillar,
			rootId: record.root.id
		}))
	);
	const duplicateEntities = production.flatMap((record) =>
		record.duplicateEntities.map((item) => ({
			...item,
			file: record.displayPath,
			concept: record.concept,
			pillar: record.pillar,
			rootId: record.root.id
		}))
	);
	const pathwayReport = pathwayEvidence(duplicateEntities, profile.genericLabels);
	const duplicatePathways: Array<DuplicateGroup> = pathwayReport.exact;
	const overlappingPathways: Array<OverlapPair> = pathwayReport.overlapping;
	const functionalityClusters: Array<FunctionalityCluster> = pathwayReport.clusters;
	const structuralInlineCandidates: Array<InlineCandidate> = production
		.flatMap((record) =>
			record.inlineCandidates.map((candidate) => ({
				...candidate,
				file: record.displayPath,
				concept: record.concept,
				pillar: record.pillar
			}))
		)
		.sort(
			(left, right) =>
				left.file.localeCompare(right.file) ||
				left.line - right.line ||
				left.name.localeCompare(right.name)
		);
	const recordByDisplayPath = new Map(production.map((record) => [record.displayPath, record]));
	const inlineCandidates: Array<InlineCandidate> = quality
		? quality.findings
				.filter(({ rule }) => rule === 'Q1' || rule === 'Q3' || rule === 'Q4')
				.map((finding) => {
					const record = recordByDisplayPath.get(finding.file ?? '');
					const fields = new Map(
						(finding.evidence ?? '')
							.split(/\s+/)
							.map((field) => field.split('=', 2))
							.filter((field) => field.length === 2)
							.map(([key, value]) => [key ?? '', value ?? ''])
					);
					return {
						name: fields.get('name') ?? '<unknown>',
						line: finding.line,
						useLine: null,
						kind:
							fields.get('kind') ??
							(finding.rule === 'Q1'
								? 'callback-proxy'
								: finding.rule === 'Q3'
									? 'transparent-forwarder'
									: 'single-use-expression'),
						confidence: finding.rule === 'Q4' ? 'review' : 'high',
						tokens: null,
						file: finding.file,
						concept: record?.concept ?? finding.concept,
						pillar: record?.pillar ?? 'unmapped'
					};
				})
				.sort(
					(left, right) =>
						(left.file ?? '').localeCompare(right.file ?? '') ||
						(left.line ?? 0) - (right.line ?? 0) ||
						left.name.localeCompare(right.name)
				)
		: structuralInlineCandidates;
	const pillars: Array<PillarReport> = buildPillars(
		production,
		productionAdjacency,
		byPath,
		cycles,
		quality,
		inlineCandidates
	);
	const conceptMap = new Map<
		string,
		{
			concept: string;
			files: number;
			codeLoc: number;
			functions: number;
			services: Array<{ name: string; file: string }>;
			outgoingConcepts: Set<string>;
			incomingConcepts: Set<string>;
		}
	>();
	for (const record of production) {
		const concept = conceptMap.get(record.concept) ?? {
			concept: record.concept,
			files: 0,
			codeLoc: 0,
			functions: 0,
			services: [],
			outgoingConcepts: new Set<string>(),
			incomingConcepts: new Set<string>()
		};
		concept.files += 1;
		concept.codeLoc += record.lines.code;
		concept.functions += record.functions.length;
		concept.services.push(...record.services.map((name) => ({ name, file: record.displayPath })));
		conceptMap.set(record.concept, concept);
	}
	for (const [from, targets] of productionAdjacency)
		for (const target of targets) {
			const sourceConcept = byPath.get(from)?.concept;
			const targetConcept = byPath.get(target)?.concept;
			if (sourceConcept !== targetConcept && sourceConcept && targetConcept) {
				conceptMap.get(sourceConcept)?.outgoingConcepts.add(targetConcept);
				conceptMap.get(targetConcept)?.incomingConcepts.add(sourceConcept);
			}
		}
	const concepts: Array<ConceptReport> = [...conceptMap.values()]
		.map((item) => ({
			concept: item.concept,
			files: item.files,
			codeLoc: item.codeLoc,
			functions: item.functions,
			services: item.services.sort((a, b) => a.name.localeCompare(b.name)),
			fanInConcepts: item.incomingConcepts.size,
			fanOutConcepts: item.outgoingConcepts.size
		}))
		.sort((a, b) => b.codeLoc - a.codeLoc || a.concept.localeCompare(b.concept));
	const services: Array<ServiceReport> = concepts
		.flatMap((concept) =>
			concept.services.map((service) => ({ ...service, concept: concept.concept }))
		)
		.sort((a, b) => a.concept.localeCompare(b.concept) || a.name.localeCompare(b.name));
	const reached = testReach(
		new Set(tests.map((record) => record.path)),
		valueAdjacency,
		productionSet
	);
	const productionCode = production.reduce((sum, record) => sum + record.lines.code, 0);
	const testCode = tests.reduce((sum, record) => sum + record.lines.code, 0);
	const unconfiguredTestCode = testCandidates
		.filter((record) => !record.configuredTest)
		.reduce((sum, record) => sum + record.lines.code, 0);
	const qualityCode = quality
		? production
				.filter((record) => !(quality.coverage?.unscannedFiles.includes(record.displayPath) ?? false))
				.reduce((sum, record) => sum + record.lines.code, 0)
		: 0;
	if (quality && quality.coverage) quality.coverage.productionCodeLoc = qualityCode;
	if (quality)
		quality.byPrinciple = quality.byPrinciple.map((item) => ({
			name: item.name,
			count: item.count,
			perThousandProductionLoc:
				qualityCode === 0 ? null : Math.round((item.count / (qualityCode / 1000)) * 1000) / 1000
		}));
	const modularity = 100 - coupling;
	const moduleColocation = localityScore(importLocalities);
	const testability =
		50 * Math.min(1, testCode / Math.max(productionCode * 0.5, 1)) +
		(50 * reached.size) / Math.max(production.length, 1);
	const complexityDistribution = distribution(functions.map((item) => item.cyclomatic));
	const nestingDistribution = distribution(functions.map((item) => item.nesting));
	const passThrough = functions.filter((item) => item.passThrough).length;
	const simplicity =
		100 *
		(1 -
			(0.45 * Math.min(1, complexityDistribution.p95 / 15) +
				0.3 * Math.min(1, nestingDistribution.p95 / 8) +
				(0.25 * passThrough) / Math.max(functions.length, 1)));
	const clamp = (value: number): number => Math.max(0, Math.min(100, value));
	const rawScores: Scores = {
		coupling: clamp(coupling),
		modularity: clamp(modularity),
		colocation: clamp(moduleColocation),
		testability: clamp(testability),
		simplicity: clamp(simplicity),
		staticQuality: null,
		health: null
	};
	if (quality && (quality.coverage?.unscannedProductionFiles ?? 1) === 0) {
		const weightedDensity =
			qualityCode === 0
				? quality.totals.error + quality.totals.warning === 0
					? 0
					: Number.POSITIVE_INFINITY
				: (4 * quality.totals.error + quality.totals.warning) / (qualityCode / 1000);
		rawScores.staticQuality = clamp(100 / (1 + weightedDensity));
		rawScores.health = clamp(
			0.3 * (rawScores.modularity ?? 0) +
				0.2 * (rawScores.testability ?? 0) +
				0.2 * (rawScores.simplicity ?? 0) +
				0.3 * (rawScores.staticQuality ?? 0)
		);
	}
	const round = (value: number | null): number | null =>
		value === null ? null : Math.round(value * 100) / 100;
	const scores = Object.fromEntries(
		Object.entries(rawScores).map(([name, value]) => [name, round(value)])
	) as Scores;
	const scorePrecision = Object.fromEntries(
		Object.entries(rawScores).map(([name, value]) => [
			name,
			value === null ? null : Math.round(value * 1_000_000_000_000) / 1_000_000_000_000
		])
	) as Scores;
	const hotspots: Array<Hotspot> = production
		.map((record) => ({
			file: record.displayPath,
			concept: record.concept,
			codeLoc: record.lines.code,
			fanIn: incoming.get(record.path) ?? 0,
			fanOut: (productionAdjacency.get(record.path) ?? new Set()).size,
			p95Complexity: distribution(record.functions.map((item) => item.cyclomatic)).p95
		}))
		.sort((a, b) => b.codeLoc - a.codeLoc || b.fanIn - a.fanIn || a.file.localeCompare(b.file))
		.slice(0, 30);
	return {
		schemaVersion: SCHEMA_VERSION,
		analyzerVersion: ANALYZER_VERSION,
		roots: rootDescriptions,
		totals: {
			files: records.length,
			productionFiles: production.length,
			testFiles: tests.length,
			unconfiguredTestFiles: testCandidates.length - tests.length,
			physicalLoc: records.reduce((sum, record) => sum + record.lines.physical, 0),
			codeLoc: productionCode + testCode + unconfiguredTestCode,
			productionCodeLoc: productionCode,
			testCodeLoc: testCode,
			unconfiguredTestCodeLoc: unconfiguredTestCode,
			commentLoc: records.reduce((sum, record) => sum + record.lines.comments, 0),
			blankLoc: records.reduce((sum, record) => sum + record.lines.blank, 0),
			concepts: concepts.length,
			pillars: pillars.length,
			services: services.length,
			functions: functions.length,
			codeEntities: duplicateEntities.length,
			passThroughFunctions: passThrough,
			inlineCandidates: inlineCandidates.length,
			highConfidenceInlineCandidates: inlineCandidates.filter(
				({ confidence }) => confidence === 'high'
			).length,
			reviewInlineCandidates: inlineCandidates.filter(({ confidence }) => confidence === 'review')
				.length,
			transparentForwarders: inlineCandidates.filter(({ kind }) => kind === 'transparent-forwarder')
				.length,
			callbackProxies: inlineCandidates.filter(({ kind }) => kind === 'callback-proxy').length,
			singleUseExpressions: inlineCandidates.filter(({ kind }) => kind === 'single-use-expression')
				.length,
			sameFileNamedCalls: production.reduce((sum, record) => sum + record.localNamedCalls, 0),
			internalImportEdges: internalEdges,
			crossConceptEdges,
			externalImports,
			unresolvedInternalImports,
			cyclicModules,
			cycleGroups: cycles.length,
			duplicatePathwayGroups: duplicatePathways.length,
			duplicatePathwayOccurrences: duplicatePathways.reduce(
				(sum, group) => sum + group.occurrences.length,
				0
			),
			overlappingPathwayPairs: overlappingPathways.length,
			functionalityClusters: functionalityClusters.length,
			crossConceptFunctionalityClusters: functionalityClusters.filter(
				({ crossConcept }) => crossConcept
			).length,
			crossPillarFunctionalityClusters: functionalityClusters.filter(
				({ crossPillar }) => crossPillar
			).length,
			clusteredEntityOccurrences: functionalityClusters.reduce(
				(sum, cluster) => sum + cluster.members.length,
				0
			),
			testReachedProductionModules: reached.size,
			staticErrors: quality?.totals.error ?? null,
			staticWarnings: quality?.totals.warning ?? null
		},
		scores,
		scorePrecision,
		quality,
		distributions: {
			productionFileCodeLoc: distribution(production.map((record) => record.lines.code)),
			functionCyclomatic: complexityDistribution,
			functionNesting: nestingDistribution,
			fanIn: distribution(fanIn),
			fanOut: fanOutStats,
			pillarCodeLoc: distribution(pillars.map(({ codeLoc }) => codeLoc)),
			pillarCohesion: distribution(pillars.map(({ cohesion }) => cohesion)),
			pillarComplexityDensity: distribution(
				pillars.map(({ complexity }) => complexity.excessPerThousandLoc)
			),
			pillarIndirectionDensity: distribution(
				pillars.map(({ indirection }) => indirection.perHundredNamedFunctions)
			)
		},
		colocation: {
			importEdges: importLocalities,
			importScore: moduleColocation,
			sameFileNamedCalls: production.reduce((sum, record) => sum + record.localNamedCalls, 0)
		},
		concepts,
		pillars,
		services,
		cycles: cycles.map((component) =>
			component.map((path) => byPath.get(path)?.displayPath ?? path)
		),
		duplicatePathways,
		overlappingPathways,
		functionalityClusters,
		inlineCandidates,
		hotspots
	};
}
