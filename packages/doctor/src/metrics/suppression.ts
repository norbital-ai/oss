/**
 * Suppression census: how often a codebase tells some checker to look away.
 *
 * Every suppression dialect — this repository's own `repository-health:allow`, ESLint's disable
 * family, TypeScript's ignore/expect-error pair, `noqa`, `nosonar` — is a reviewed exception,
 * and exceptions accrete silently. Counting them is cheap honesty: the totals feed trend lines,
 * not verdicts.
 *
 * The match is deliberately a regex over raw source rather than a trivia-aware scan. A comment
 * parser would cost a second parse per file to distinguish "in a comment" from "in a string" —
 * a distinction that changes almost nothing here, since a string literal naming `@ts-ignore` is
 * itself worth noticing. Word boundaries keep near-misses out (`eslint-disabled` matches
 * nothing; `@ts-ignorex` likewise). Variants tally under their exact text, so
 * `eslint-disable-next-line` does not inflate the plain `eslint-disable` count, and `total` is
 * the plain sum across tags.
 */
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
