/**
 * Deterministic statistics and baseline comparison, ported from `analyze.mjs`.
 *
 * Every distribution in the report comes from `distribution`: count, mean, population standard
 * deviation, coefficient of variation, Gini, and nearest-rank percentiles over one sorted copy.
 * Display values round to three decimals; the composite scores keep more precision and round once,
 * at the boundary, because rounding twice is how a release gate drifts from its own definition.
 *
 * `compare` is the regression gate. It deliberately does not validate the baseline's numbers: a
 * missing key produces the same not-a-number delta today as it did when the gate shipped, and the
 * serialized report shows it as `null` either way. Changing that would change bytes for baselines
 * that were already meaningless.
 */

/** Descriptive statistics over a finite metric population, rounded for display. */
export type Distribution = Readonly<{
	count: number;
	mean: number;
	stdev: number;
	cv: number;
	gini: number;
	median: number;
	p90: number;
	p95: number;
	max: number;
}>;

/** Calculate deterministic descriptive statistics over a finite metric population. */
export function distribution(values: ReadonlyArray<number>): Distribution {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0)
		return { count: 0, mean: 0, stdev: 0, cv: 0, gini: 0, median: 0, p90: 0, p95: 0, max: 0 };
	const sum = sorted.reduce((total, value) => total + value, 0);
	const mean = sum / sorted.length;
	const stdev = Math.sqrt(
		sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / sorted.length
	);
	const percentile = (fraction: number): number =>
		sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
	const weighted = sorted.reduce((total, value, index) => total + (index + 1) * value, 0);
	const gini =
		sum === 0 ? 0 : (2 * weighted) / (sorted.length * sum) - (sorted.length + 1) / sorted.length;
	const rounded = (value: number): number => Math.round(value * 1000) / 1000;
	return {
		count: sorted.length,
		mean: rounded(mean),
		stdev: rounded(stdev),
		cv: rounded(mean === 0 ? 0 : stdev / mean),
		gini: rounded(gini),
		median: percentile(0.5),
		p90: percentile(0.9),
		p95: percentile(0.95),
		max: sorted.at(-1) ?? 0
	};
}

/** A share of a whole, rounded to six decimals; an empty denominator is zero, not an error. */
export function roundedRatio(numerator: number, denominator: number, scale = 1): number {
	return denominator === 0
		? 0
		: Math.round((scale * numerator * 1_000_000) / denominator) / 1_000_000;
}

/** The shape of one side of a comparison: the report itself or its decoded baseline. */
export type ComparisonSide = Readonly<{
	schemaVersion: unknown;
	analyzerVersion: unknown;
	roots: unknown;
	scorePrecision: Readonly<Record<string, number | null>>;
	totals: Readonly<Record<string, number | null>>;
}>;

/** The outcome of a baseline comparison: every computed delta and the human-readable regressions. */
export type Comparison = Readonly<{
	deltas: Record<string, number>;
	regressions: Array<string>;
}>;

/** Compare score and architecture regressions against a schema-compatible baseline. */
export function compare(report: ComparisonSide, baseline: ComparisonSide): Comparison {
	if (
		baseline.schemaVersion !== report.schemaVersion ||
		baseline.analyzerVersion !== report.analyzerVersion
	)
		throw new Error(
			`baseline analyzer/schema does not match ${report.analyzerVersion}/${report.schemaVersion}`
		);
	if (JSON.stringify(baseline.roots) !== JSON.stringify(report.roots))
		throw new Error('baseline roots do not match the selected roots');
	const deltas: Record<string, number> = {};
	for (const key of Object.keys(report.scorePrecision))
		if (report.scorePrecision[key] !== null && baseline.scorePrecision[key] !== null)
			deltas[key] =
				Math.round(
					((report.scorePrecision[key] ?? Number.NaN) - (baseline.scorePrecision[key] ?? Number.NaN)) *
						1_000_000_000
				) / 1_000_000_000;
	for (const key of [
		'productionFiles',
		'productionCodeLoc',
		'concepts',
		'pillars',
		'services',
		'cyclicModules',
		'cycleGroups',
		'duplicatePathwayGroups',
		'duplicatePathwayOccurrences',
		'overlappingPathwayPairs',
		'functionalityClusters',
		'crossConceptFunctionalityClusters',
		'crossPillarFunctionalityClusters',
		'clusteredEntityOccurrences',
		'inlineCandidates',
		'staticErrors',
		'staticWarnings'
	])
		if (report.totals[key] !== null && baseline.totals[key] !== null)
			deltas[key] =
				(report.totals[key] ?? Number.NaN) - (baseline.totals[key] ?? Number.NaN);
	const regressions: Array<string> = [];
	if ((deltas.coupling ?? 0) > 0) regressions.push(`coupling +${deltas.coupling}`);
	for (const key of [
		'modularity',
		'colocation',
		'testability',
		'simplicity',
		'staticQuality',
		'health'
	])
		if ((deltas[key] ?? 0) < 0) regressions.push(`${key} ${deltas[key]}`);
	for (const key of [
		'cyclicModules',
		'cycleGroups',
		'duplicatePathwayGroups',
		'duplicatePathwayOccurrences',
		'overlappingPathwayPairs',
		'functionalityClusters',
		'crossConceptFunctionalityClusters',
		'crossPillarFunctionalityClusters',
		'clusteredEntityOccurrences',
		'inlineCandidates',
		'staticErrors',
		'staticWarnings'
	])
		if ((deltas[key] ?? 0) > 0) regressions.push(`${key} +${deltas[key]}`);
	return { deltas, regressions };
}
