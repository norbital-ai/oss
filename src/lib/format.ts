/** Display formatting shared by the reconstruction surfaces. */

/**
 * A measured number for display, or an em dash when there is nothing to show.
 *
 * Every reconstruction figure can be absent — a failed run stores no metrics, and a metrics blob
 * that fails validation reads as missing rather than as zero. Rendering `0` for "not measured"
 * would put a confident number in front of an engineer who has no measurement at all.
 */
export function formatNumber(value: number | null | undefined, digits = 0): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
	return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}
