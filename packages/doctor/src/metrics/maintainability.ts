/**
 * The Maintainability Index, in its classic SEI form.
 *
 * MI compresses three measurements — Halstead volume (how much to read), cyclomatic complexity
 * (how many paths through it), and line count (how long) — onto a 0..100 scale via the SEI
 * formulation `(171 − 5.2·ln(V) − 0.23·CC − 16.2·ln(LOC)) · 100 / 171`. The constants are the
 * ones every implementation ships; changing them would break comparability with everything else
 * that calls itself MI, so they are not configurable here.
 *
 * The degenerate guard doubles as a semantic statement: an empty body has nothing to maintain,
 * so it scores 100 rather than −∞. `ln(0)` would otherwise dominate all three terms. Cyclomatic
 * enters linearly because it already starts at 1 for straight-line code; volume and LOC enter
 * logarithmically because doubling either hurts far less than the first few units did.
 */
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
