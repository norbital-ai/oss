/**
 * The roster import workbook, as the shape `roster_entries/+pipelines.ts` accepts.
 *
 * This is the browser half of the import: the sheet named `Roster`, one row per person per day,
 * turned into the JSON the pipeline declares. It resolves nothing — employee numbers, shift codes
 * and the holiday calendar are the server's to check, against the company the roster belongs to.
 */

import {
	readRows,
	readSheetTable,
	type RowReader,
	type WorkbookGrids
} from '../../../lib/workbook-rows.js';

export const ROSTER_SHEET_NAME = 'Roster';
const REQUIRED_COLUMNS = ['employee_number', 'work_date', 'day_type', 'shift_code'] as const;
const DAY_TYPES = ['WORK', 'REST', 'OFF', 'PUBLIC_HOLIDAY'] as const;

export interface RosterImportRow {
	readonly employee_number: string;
	readonly work_date: string;
	readonly day_type: (typeof DAY_TYPES)[number];
	/**
	 * Required on a `WORK` row and optional on every other kind.
	 *
	 * A rest, off or public-holiday day schedules no shift, so it has no shift code to give. The
	 * workbook already in operators' hands repeats the employee's ordinary shift on every line, and
	 * that still reads: the cell is accepted on a non-working row and the pipeline discards it. Only
	 * a WORK row with the cell empty is refused, because a working day with no shift has no hours.
	 */
	readonly shift_code?: string;
	readonly assignment_code?: string;
	readonly note?: string;
}

export interface RosterImportPayload {
	readonly roster_id: string;
	readonly rows: readonly RosterImportRow[];
}

function identifyRosterRow(reader: RowReader): string {
	const named = [reader.text('employee_number'), reader.text('work_date')]
		.filter((part) => part != null)
		.join(' on ');
	return named === '' ? `Row ${reader.rowNumber}` : `Row ${reader.rowNumber} (${named})`;
}

/**
 * Builds the import payload for one draft roster month.
 *
 * A blank optional cell reads as absent, and `JSON.stringify` drops it on the way out: the
 * pipeline's schema takes `assignment_code` as an optional NON-EMPTY string, so an empty cell is the
 * absence of a code rather than a code that happens to be empty.
 *
 * The `?? ''` fallbacks are unreachable in a returned row — a rejected cell records a problem, and
 * `readRows` refuses the whole file before any row it built is returned. They are there so the row
 * type stays honest about what a complete row is.
 */
export function rosterImportPayload(grids: WorkbookGrids, rosterId: string): RosterImportPayload {
	const table = readSheetTable(grids, ROSTER_SHEET_NAME, REQUIRED_COLUMNS);
	const rows = readRows(table, identifyRosterRow, (reader): RosterImportRow => {
		const dayType = reader.choice('day_type', DAY_TYPES, true) ?? 'WORK';
		return {
			employee_number: reader.requiredText('employee_number') ?? '',
			work_date: reader.calendarDate('work_date') ?? '',
			day_type: dayType,
			// A working day must name the shift that gives it its hours; no other kind of day has one.
			shift_code:
				dayType === 'WORK' ? reader.requiredText('shift_code') : reader.text('shift_code'),
			assignment_code: reader.text('assignment_code'),
			note: reader.text('note')
		};
	});
	return { roster_id: rosterId, rows };
}
