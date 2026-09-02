import { decodeNumber } from '@norbital-ai/std/json';

/**
 * Numeric database columns may cross the PostgreSQL boundary as decimal strings so precision is
 * not silently lost in transport. Renderers accept those wire values while still refusing blank,
 * non-finite, and unrelated strings.
 */
export function coerceNumericValue(value: unknown): number | null {
	const numeric = decodeNumber(value);
	return Number.isFinite(numeric) ? numeric : null;
}
