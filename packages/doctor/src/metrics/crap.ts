/**
 * CRAP — Change Risk Analysis and Predictions — for one function.
 *
 * CRAP says a function's risk is dominated by its untested complexity: `comp² · (1−cov)³ + cov`.
 * Fully covered code scores exactly its complexity (`cov = 1` zeroes the comp term), which is
 * the point — high complexity is acceptable precisely where tests pin it down. Coverage missing
 * propagates as `null`: guessing 0 would brand every unmeasured file maximally risky, and a
 * number that dramatic stops being read. Out-of-range coverage throws instead of clamping;
 * silent clamping would let a percent-vs-fraction mixup pass unnoticed.
 *
 * The cube on uncovered fraction makes risk collapse quickly toward plain complexity as coverage
 * climbs, so partial credit is deliberately stingy.
 */
export function crap(cyclomatic: number, coverage: number | null): number | null {
	if (coverage === null) return null;
	if (coverage < 0 || coverage > 1 || Number.isNaN(coverage))
		throw new Error(`norbital-doctor: coverage ${coverage} lies outside 0..1`);
	const uncovered = 1 - coverage;
	return cyclomatic * cyclomatic * uncovered * uncovered * uncovered + coverage;
}
