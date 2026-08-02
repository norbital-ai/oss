/** Display helpers for payslip provenance reached through nested source relations. */

/** A stored date-ish value as its calendar day; a `date()` column may arrive as either. */
export function dayKey(value: unknown): string {
	return String(value ?? '').slice(0, 10);
}

/**
 * How a list of consumed references reads, including the states that are not a list yet. The
 * sentinel strings are deliberate: "nothing was consumed" and "we have not looked yet" are
 * different answers, and neither may be shown as an empty cell.
 */
export function consumedReferenceText(input: {
	readonly loading: boolean;
	readonly error?: string | null;
	readonly references: readonly string[];
}): string {
	if (input.error) return input.error;
	if (input.loading) return 'Loading…';
	if (input.references.length === 0) return '—';
	return input.references.join(', ');
}
