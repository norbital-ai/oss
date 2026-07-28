/**
 * Reading effective-dated configuration.
 *
 * Every configuration collection is a history: a change is an end-date plus a successor row, never
 * an update in place, and a Postgres exclusion constraint guarantees no two rows for the same key
 * overlap. So a lookup on a date returns at most one row *structurally* — these helpers exist to
 * make that fact usable, not to resolve ambiguity that cannot arise.
 */

import type { IsoDate } from './dates.js';

/** The JSONB shape of a `dateRange()` column. `end` of `null` is open-ended. */
export type StoredRange = { readonly start: string; readonly end: string | null };

function readRange(value: unknown): StoredRange | null {
	if (value == null || typeof value !== 'object') return null;
	const start = Reflect.get(value, 'start');
	if (typeof start !== 'string' || start === '') return null;
	const end = Reflect.get(value, 'end');
	return { start, end: typeof end === 'string' && end !== '' ? end : null };
}

/** Whether an `effective_range` covers a calendar day. Both ends inclusive. */
export function coversDate(range: unknown, date: IsoDate): boolean {
	const parsed = readRange(range);
	if (!parsed) return false;
	if (parsed.start.slice(0, 10) > date) return false;
	return parsed.end == null || parsed.end.slice(0, 10) >= date;
}

/** Whether an `effective_range` touches any day of `[start, end]`. */
export function overlapsRange(range: unknown, start: IsoDate, end: IsoDate): boolean {
	const parsed = readRange(range);
	if (!parsed) return false;
	if (parsed.start.slice(0, 10) > end) return false;
	return parsed.end == null || parsed.end.slice(0, 10) >= start;
}

type Dated = { readonly effective_range?: unknown };

/** The single row effective on a day, or `undefined`. */
export function effectiveOn<T extends Dated>(rows: readonly T[], date: IsoDate): T | undefined {
	return rows.find((row) => coversDate(row.effective_range, date));
}

/** Every row touching `[start, end]`, in effective order. */
export function effectiveWithin<T extends Dated>(
	rows: readonly T[],
	start: IsoDate,
	end: IsoDate
): T[] {
	return rows
		.filter((row) => overlapsRange(row.effective_range, start, end))
		.toSorted((left, right) =>
			String(readRange(left.effective_range)?.start ?? '').localeCompare(
				String(readRange(right.effective_range)?.start ?? '')
			)
		);
}

/** The row effective on a day, or a named error naming what was missing. */
export function requireEffectiveOn<T extends Dated>(
	rows: readonly T[],
	date: IsoDate,
	what: string
): T {
	const row = effectiveOn(rows, date);
	if (!row) throw new Error(`No ${what} is effective on ${date}.`);
	return row;
}

/** The `[start, end]` days of an effective range clipped into a window. */
export function clipRange(
	range: unknown,
	window: { start: IsoDate; end: IsoDate }
): { start: IsoDate; end: IsoDate } | null {
	const parsed = readRange(range);
	if (!parsed) return null;
	const start = parsed.start.slice(0, 10) > window.start ? parsed.start.slice(0, 10) : window.start;
	const rawEnd = parsed.end?.slice(0, 10) ?? window.end;
	const end = rawEnd < window.end ? rawEnd : window.end;
	return start > end ? null : { start, end };
}

/** Only rows the platform has approved. A null approval stamp means approved on this platform. */
export type Approvable = { readonly norbital_approval_id?: string | null };

export function live<T extends Approvable>(rows: readonly T[]): T[] {
	return rows.filter((row) => row.norbital_approval_id == null);
}
