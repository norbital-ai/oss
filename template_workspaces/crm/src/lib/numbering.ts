/**
 * Human-readable document numbers, shared by every document collection.
 *
 * The scheme is `PREFIX-YEAR-SEQ`, sequence zero-padded to four digits and restarting each calendar
 * year. Numbers are allocated by reading the highest number already issued in the series, which is
 * cheap and needs no counter table — but two documents created in the same instant can choose the
 * same number. The unique index on the number column is what actually guarantees uniqueness: the
 * loser's transaction fails and is retried rather than quietly issuing a duplicate. That trade is
 * deliberate for a workspace at this scale; a workload issuing many documents per second wants a
 * counter row it can lock instead.
 */

export const DOC_NO_SEQUENCE_WIDTH = 4;

/** The `like` pattern that selects one year's series, for the query that finds the highest number. */
export function docNoSeriesPattern(prefix: string, year: number): string {
	return `${prefix}-${year}-%`;
}

/**
 * The next number in a series, given every number already issued in it.
 *
 * Numbers that do not parse are skipped rather than treated as zero, so one hand-edited number cannot
 * reset a live series back to the beginning.
 */
export function nextDocNo(
	existingNumbers: readonly string[],
	prefix: string,
	year: number
): string {
	const seriesPrefix = `${prefix}-${year}-`;
	let highest = 0;
	for (const number of existingNumbers) {
		if (!number.startsWith(seriesPrefix)) continue;
		const sequence = Number.parseInt(number.slice(seriesPrefix.length), 10);
		if (Number.isNaN(sequence)) continue;
		if (sequence > highest) highest = sequence;
	}
	return `${seriesPrefix}${String(highest + 1).padStart(DOC_NO_SEQUENCE_WIDTH, '0')}`;
}
