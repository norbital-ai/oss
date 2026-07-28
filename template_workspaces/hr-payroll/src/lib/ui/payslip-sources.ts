/**
 * Reading `payslip_line_sources` from a surface.
 *
 * Provenance is rows, not a column: one payslip line may have consumed many time entries, and one
 * component entry is consumed by exactly one line of one payslip. Neither direction is a foreign
 * key — the identifier lives inside the `payslip_line_source` variant — so both directions are
 * resolved by reading the link rows and matching the arm, here rather than in each representation.
 */
import { payslipLineSourceSchema } from '../../custom-types/payslip_line_source/+definition.js';

/** The link row as any surface sees it: the line it belongs to, and the opaque variant. */
export interface PayslipLineSourceRow {
	readonly payslip_line_id: string;
	readonly source: unknown;
}

export interface ConsumedRecordIds {
	readonly entryIds: readonly string[];
	readonly timeEntryIds: readonly string[];
	readonly leaveRequestIds: readonly string[];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/** Split link rows into the three collections they point at. */
export function consumedRecordIds(rows: readonly PayslipLineSourceRow[]): ConsumedRecordIds {
	const entryIds: string[] = [];
	const timeEntryIds: string[] = [];
	const leaveRequestIds: string[] = [];
	for (const row of rows) {
		const parsed = payslipLineSourceSchema.safeParse(row.source);
		// A row written by an older definition must not take the panel down with it.
		if (!parsed.success) continue;
		const source = parsed.data;
		if (source.kind === 'COMPONENT_ENTRY') entryIds.push(source.entry_id);
		else if (source.kind === 'TIME_ENTRY') timeEntryIds.push(source.time_entry_id);
		else leaveRequestIds.push(source.leave_request_id);
	}
	return {
		entryIds: unique(entryIds),
		timeEntryIds: unique(timeEntryIds),
		leaveRequestIds: unique(leaveRequestIds)
	};
}

/** The lines that consumed one component entry — the reverse direction, read from the same rows. */
export function linesConsumingEntry(
	rows: readonly PayslipLineSourceRow[],
	entryId: string
): string[] {
	return unique(
		rows.flatMap((row) => {
			const parsed = payslipLineSourceSchema.safeParse(row.source);
			if (!parsed.success) return [];
			const source = parsed.data;
			return source.kind === 'COMPONENT_ENTRY' && source.entry_id === entryId
				? [row.payslip_line_id]
				: [];
		})
	);
}

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
