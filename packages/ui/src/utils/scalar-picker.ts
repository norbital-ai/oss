/**
 * The two places a single-or-multiple scalar picker actually branches.
 *
 * The star rating and the progress picker are the same editor over a list of numbers with a
 * different glyph on the row. Everything else about them differs; these two decisions did not,
 * and were carried in both files word for word.
 */

/** What the picker reports upward: every meaningful row, or only the first one. */
export function scalarPickerPayload(
	meaningful: readonly number[],
	multiple: boolean
): number | number[] | null {
	// `|| null` rather than `?? null`: a row still sitting at zero is not a value to report.
	return multiple ? [...meaningful] : meaningful[0] || null;
}

/** Drop the row at `index`. A single-value picker keeps its one row and clears it instead. */
export function removeScalarRow(
	rows: readonly number[],
	index: number,
	multiple: boolean
): number[] {
	if (!multiple && rows.length <= 1) return [0];
	return rows.filter((_, position) => position !== index);
}
