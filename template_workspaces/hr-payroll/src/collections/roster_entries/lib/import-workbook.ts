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
	readonly shift_code: string;
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
	const rows = readRows(table, identifyRosterRow, (reader): RosterImportRow => ({
		employee_number: reader.requiredText('employee_number') ?? '',
		work_date: reader.calendarDate('work_date') ?? '',
		day_type: reader.choice('day_type', DAY_TYPES, true) ?? 'WORK',
		shift_code: reader.requiredText('shift_code') ?? '',
		assignment_code: reader.text('assignment_code'),
		note: reader.text('note')
	}));
	return { roster_id: rosterId, rows };
}
