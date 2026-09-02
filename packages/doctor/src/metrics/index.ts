/**
 * Metric primitives for the merged analyzer: pure functions over the compiler AST plus a few
 * arithmetic formulas that take numbers in. Everything here is deterministic by contract —
 * no wall clock, no registry, no ambient state — so callers inject `now` and resolvers where
 * the outside world is unavoidable.
 */
export { cognitiveComplexity } from './cognitive.js';
export { halsteadVolume } from './halstead.js';
export type { Halstead } from './halstead.js';
export { lcomHendersonSellers } from './lcom.js';
export {
	abstractness,
	countAbstractDeclarations,
	distanceFromMainSequence,
	instability
} from './main-sequence.js';
export { analyzeAssertions } from './assertions.js';
export type { AssertionReport } from './assertions.js';
export { computeLibyear, parseRange } from './libyear.js';
export type { LibyearManifest, LibyearReport, LibyearRow, RegistryView } from './libyear.js';

const SUPPRESSION_TAG =
	/\brepository-health:allow\b|\beslint-disable-next-line\b|\beslint-disable-line\b|\beslint-disable\b|\bnoqa\b|\bnosonar\b|@ts-expect-error\b|@ts-ignore\b/g;

export type SuppressionCensus = Readonly<{
	total: number;
	tags: Readonly<Record<string, number>>;
}>;

export function countSuppressions(source: string): SuppressionCensus {
	const tags: Record<string, number> = {};
	let total = 0;
	SUPPRESSION_TAG.lastIndex = 0;
	for (
		let match = SUPPRESSION_TAG.exec(source);
		match !== null;
		match = SUPPRESSION_TAG.exec(source)
	) {
		const tag = match[0] ?? '';
		tags[tag] = (tags[tag] ?? 0) + 1;
		total += 1;
	}
	SUPPRESSION_TAG.lastIndex = 0;
	return { total, tags };
}

export type MaintainabilityInput = Readonly<{
	volume: number;
	cyclomatic: number;
	loc: number;
}>;

/** Maintainability Index clamped to [0, 100]; empty bodies (volume or loc 0) score 100. */
export function maintainabilityIndex(metrics: MaintainabilityInput): number {
	if (metrics.volume <= 0 || metrics.loc <= 0) return 100;
	const raw =
		((171 -
			5.2 * Math.log(metrics.volume) -
			0.23 * metrics.cyclomatic -
			16.2 * Math.log(metrics.loc)) *
			100) /
		171;
	return Math.min(100, Math.max(0, raw));
}

export function crap(cyclomatic: number, coverage: number | null): number | null {
	if (coverage === null) return null;
	if (coverage < 0 || coverage > 1 || Number.isNaN(coverage))
		throw new Error(`norbital-doctor: coverage ${coverage} lies outside 0..1`);
	const uncovered = 1 - coverage;
	return cyclomatic * cyclomatic * uncovered * uncovered * uncovered + coverage;
}
