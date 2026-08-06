/**
 * The roster import workbook, as the shape `roster_entries/+pipelines.ts` accepts.
 *
 * This is the browser half of the import: the sheet named `Roster`, one row per person per day,
 * turned into the JSON the pipeline declares. It resolves nothing — employee numbers and shift
 * codes are the server's to check, against the company the roster belongs to.
 *
 * The sheet does not declare what kind of day a row is — that is read off the shift cell. A row
 * naming a shift is a working day on that shift, and a row leaving the cell blank is a rest day.
 * The derivation happens here, once, so the file cannot carry a day type that disagrees with the
 * shift it names.
 */

import {
	identifyRowByColumns,
	readRows,
	readSheetTable,
	type RowReader,
	type WorkbookGrids
} from '../../../lib/workbook-rows.js';

export const ROSTER_SHEET_NAME = 'Roster';
const REQUIRED_COLUMNS = ['employee_number', 'work_date', 'shift_code'] as const;
const DAY_TYPES = ['WORK', 'REST', 'OFF', 'PUBLIC_HOLIDAY'] as const;

export interface RosterImportRow {
	readonly employee_number: string;
	readonly work_date: string;
	/**
	 * Derived, not declared: the sheet has no day-type column. A row naming a shift reads as
	 * WORK, a row leaving the shift cell blank reads as REST. OFF and PUBLIC_HOLIDAY stay in the
	 * union because the pipeline accepts them, but a workbook row never produces them — holidays
	 * are overlaid from the company calendar at calculation time, not claimed row by row.
	 */
	readonly day_type: (typeof DAY_TYPES)[number];
	/**
	 * The shift the day works its hours against. The column must exist, but a row may leave the
	 * cell blank — its presence is what makes the day WORK, and its absence is what makes the day
	 * REST, so the cell is the day type spelled out.
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
	return identifyRowByColumns(reader, ['employee_number', 'work_date']);
}

/**
 * Builds the import payload for one draft roster month.
 *
 * A blank optional cell reads as absent, and `JSON.stringify` drops it on the way out: the
 * pipeline's schema takes `assignment_code` as an optional NON-EMPTY string, so an empty cell is the
 * absence of a code rather than a code that happens to be empty.
 *
 * `assignment_code` and `note` are not in the issued template's header row, but they were in the
 * one before it, and a cell under a column the reader names is read wherever it appears — so a
 * file already in an operator's hands keeps importing with nothing lost. A `day_type` column is
 * the opposite case: it is read by nobody now, and the shift cell decides instead.
 *
 * The `?? ''` fallbacks are unreachable in a returned row — a rejected cell records a problem, and
 * `readRows` refuses the whole file before any row it built is returned. They are there so the row
 * type stays honest about what a complete row is.
 */
export function rosterImportPayload(grids: WorkbookGrids, rosterId: string): RosterImportPayload {
	const table = readSheetTable(grids, ROSTER_SHEET_NAME, REQUIRED_COLUMNS);
	const rows = readRows(table, identifyRosterRow, (reader): RosterImportRow => {
		const shiftCode = reader.text('shift_code');
		return {
			employee_number: reader.requiredText('employee_number') ?? '',
			work_date: reader.calendarDate('work_date') ?? '',
			// The day type is the shift cell's: a named shift is a working day, a blank one a rest.
			day_type: shiftCode == null ? 'REST' : 'WORK',
			shift_code: shiftCode,
			assignment_code: reader.text('assignment_code'),
			note: reader.text('note')
		};
	});
	return { roster_id: rosterId, rows };
}
