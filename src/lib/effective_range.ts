/**
 * Effective-range helpers shared by every effective-dated configuration collection.
 *
 * `effective_range` is a `dateRange()` column: JSONB `{ start, end }` holding UTC ISO instants,
 * NOT a Postgres range type. Overlap therefore cannot be enforced by an `EXCLUDE USING gist`
 * constraint and is checked here, in `create.before` / `update.before` hooks.
 */

export type EffectiveRange = {
	readonly start: string;
	/** `null` means "open ended" — treated as +infinity. */
	readonly end: string | null;
};

/** A row of any effective-dated collection, as far as the overlap check is concerned. */
export type EffectiveDatedRow = {
	readonly norbital_id: string;
	readonly effective_range?: unknown;
};

function instant(value: string, what: string): number {
	const milliseconds = Date.parse(value);
	if (Number.isNaN(milliseconds)) {
		throw new Error(`${what} is not a valid ISO instant: "${value}".`);
	}
	return milliseconds;
}

/** Validate and normalise a raw `effective_range` value. */
export function parseEffectiveRange(value: unknown, what = 'effective_range'): EffectiveRange {
	if (value == null || typeof value !== 'object') {
		throw new Error(`${what} is required.`);
	}
	const start = Reflect.get(value, 'start');
	const end = Reflect.get(value, 'end');
	if (typeof start !== 'string' || start === '') {
		throw new Error(`${what}.start is required.`);
	}
	if (end != null && typeof end !== 'string') {
		throw new Error(`${what}.end must be an ISO instant or null.`);
	}
	const normalizedEnd = end == null || end === '' ? null : end;
	if (
		normalizedEnd !== null &&
		instant(normalizedEnd, `${what}.end`) <= instant(start, `${what}.start`)
	) {
		throw new Error(`${what}.end must be after ${what}.start.`);
	}
	return { start, end: normalizedEnd };
}

/** `[aStart, aEnd)` and `[bStart, bEnd)` overlap iff `aStart < bEnd && bStart < aEnd`. */
export function rangesOverlap(a: EffectiveRange, b: EffectiveRange): boolean {
	const aStart = instant(a.start, 'effective_range.start');
	const bStart = instant(b.start, 'effective_range.start');
	const aEnd = a.end === null ? Number.POSITIVE_INFINITY : instant(a.end, 'effective_range.end');
	const bEnd = b.end === null ? Number.POSITIVE_INFINITY : instant(b.end, 'effective_range.end');
	return aStart < bEnd && bStart < aEnd;
}

/**
 * Half-open numeric band overlap, used for the second dimension of the two-dimensional
 * exclusions (wage bands, overtime bands). A `null` upper bound is the terminal band.
 */
export function numericRangesOverlap(
	aFrom: number,
	aTo: number | null,
	bFrom: number,
	bTo: number | null
): boolean {
	const aEnd = aTo === null ? Number.POSITIVE_INFINITY : aTo;
	const bEnd = bTo === null ? Number.POSITIVE_INFINITY : bTo;
	return aFrom < bEnd && bFrom < aEnd;
}

/**
 * Throw when the candidate range overlaps any of `existing`.
 *
 * `existing` must already be narrowed to the rows sharing the candidate's identity key —
 * scalar parts via the database query, variant/JSONB parts by filtering in TypeScript.
 */
export function assertNoOverlap(options: {
	readonly candidate: unknown;
	readonly existing: readonly EffectiveDatedRow[];
	/** Human-readable identity key, used in the error message. */
	readonly identity: string;
	/** The row being updated, which must not conflict with itself. */
	readonly excludeId?: string | null;
}): void {
	const candidate = parseEffectiveRange(options.candidate, `${options.identity}: effective_range`);
	for (const row of options.existing) {
		if (options.excludeId != null && row.norbital_id === options.excludeId) continue;
		const other = parseEffectiveRange(row.effective_range);
		if (rangesOverlap(candidate, other)) {
			throw new Error(
				`Effective range ${candidate.start} → ${candidate.end ?? '∞'} overlaps an existing row ` +
					`for ${options.identity} (${other.start} → ${other.end ?? '∞'}). ` +
					`End-date the existing row and insert a successor instead of overlapping it.`
			);
		}
	}
}
