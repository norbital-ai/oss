/**
 * Numeric database columns may cross the PostgreSQL boundary as decimal strings so precision is
 * not silently lost in transport. Renderers accept those wire values while still refusing blank,
 * non-finite, and unrelated strings.
 */
export function coerceNumericValue(value: unknown): number | null {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string' || value.trim() === '') return null;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}
