/**
 * The two import templates operators are issued, written to `~/Downloads`.
 *
 * The sheets mirror exactly what the readers in `src/collections/roster_entries/lib` and
 * `src/collections/time_entries/lib` accept: the roster sheet carries three columns and derives
 * the day type off the shift cell — a named shift is a working day, a blank one a rest day — and
 * the time-entry sheet carries four columns, with the timezone declared once on the `Settings`
 * sheet. The `Read me first` sheets state the rules in the same terms the readers enforce them,
 * so what the file promises and what the import accepts cannot drift apart quietly.
 *
 * The script is re-runnable and deterministic: the workbook metadata is pinned to a fixed instant,
 * so two runs emit the same bytes, and it reads each file back on the way out and asserts the
 * header row it shipped.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

/** Fixed so a re-run emits the same bytes. The value itself is arbitrary; its fixedness is not. */
const EPOCH = new Date('2026-08-04T16:00:00.000Z');

/*
 * ExcelJS packs the workbook through JSZip, and JSZip stamps every entry with the instant it was
 * added — two runs a second apart would otherwise emit different bytes for the same sheets. The
 * zip library is ExcelJS's own dependency rather than this workspace's, so it is reached through
 * ExcelJS's resolution, and its default entry date is pinned to the same instant as the metadata.
 */
createRequire(createRequire(import.meta.url).resolve('exceljs'))('jszip').defaults.date = EPOCH;

const ROSTER_TEMPLATE_PATH = path.join(
	os.homedir(),
	'Downloads',
	'norbital-roster-import-template.xlsx'
);
const TIME_TEMPLATE_PATH = path.join(
	os.homedir(),
	'Downloads',
	'norbital-time-entries-import-template.xlsx'
);

const ROSTER_HEADERS = ['employee_number', 'work_date', 'shift_code'];
const ROSTER_SAMPLE_ROWS = [
	['NHPMY0002', '2026-05-01', '7.5AM'],
	['NHPMY0002', '2026-05-02', '7.5AM'],
	['NHPMY0002', '2026-05-03', ''],
	['NHPMY0002', '2026-05-04', '7.5AM'],
	['NHPMY0002', '2026-05-05', '7.5AM'],
	['NHPMY0023', '2026-05-04', 'AM0830'],
	['NHPMY0023', '2026-05-05', 'PM2030'],
	['NHPMY0023', '2026-05-06', '']
];

const TIME_ENTRY_HEADERS = ['employee_number', 'work_date', 'clock_in', 'clock_out'];
const TIME_ENTRY_SAMPLE_ROWS = [
	['NHPMY0002', '2026-05-04', '08:16', '17:10'],
	['NHPMY0002', '2026-05-05', '08:02', '17:05'],
	['NHPMY0023', '2026-05-04', '20:30', '05:15'],
	['NHPMY0023', '2026-05-05', '20:28', '05:02'],
	['NHPMY0023', '2026-05-06', '20:31', '']
];

const SETTINGS_ROWS = [
	['Setting', 'Value'],
	['timezone', 'Asia/Kuala_Lumpur'],
	[],
	['', 'An IANA timezone name. Asia/Kuala_Lumpur, Asia/Manila, Asia/Jakarta, Asia/Singapore.']
];

const ROSTER_README = [
	'Roster import — planned assignment',
	'',
	'One row per person per day, on the "Roster" sheet. Do not rename the sheet or the column headers.',
	'',
	'A roster is a work ASSIGNMENT — who is scheduled where. It is not attendance. Use the time-entries',
	'template for what actually happened on the clock. Importing one does not populate the other.',
	'',
	'Two rules that change what people get paid',
	'',
	'• The day type is read off the shift cell — there is no column for it. A row naming a shift_code',
	'  is a working day on that shift; a row leaving shift_code empty is a rest day. The two cannot',
	'  disagree, because one is derived from the other.',
	'',
	'• shift_code must name an existing shift definition. The hours a working day earns are measured',
	'  against the shift it names, so a code the company has not defined refuses the file.',
	'',
	'What is refused',
	'',
	'The whole file is refused, not individual rows, and the offending rows are named: unknown employee',
	'or shift code, a date outside the roster month, an already-published roster, duplicates inside the',
	'file, and rows already on file.',
	'',
	'Accepted values',
	'',
	'employee_number   as seeded on the employment, e.g. NHPMY0002',
	'work_date         YYYY-MM-DD (all rows must fall inside one roster month)',
	'shift_code        an existing shift code, e.g. 7.5AM · 8.0AM · 8.5AM · AM0830 · AM1030 · PM2030 ·',
	'                  PM2230 — empty on a rest day',
	'',
	'The sample rows below are illustrative. Delete them and paste your own.'
];

const TIME_README = [
	'Time entries import — actual attendance',
	'',
	'One row per person per day, on the "Time entries" sheet. Do not rename the sheet or the column',
	'headers.',
	'',
	'Set the timezone once, on the "Settings" sheet. Every clock time in this file is read as local wall',
	'time in that zone and converted to a real instant. We do not use a fixed UTC offset, so daylight',
	'saving and historical changes are handled correctly.',
	'',
	'Three rules worth knowing',
	'',
	'• An overnight shift needs no special marker. A clock_out at or before clock_in is treated as the',
	'  next calendar day.',
	'',
	'• A row carries punches only — breaks, overtime and the open/closed state are derived from them.',
	'  A row with both clocks lands closed; a row missing either clock lands open; and the payroll run',
	'  prices the hours the punches record.',
	'',
	'• A leave day is NOT a time entry. Leave lives in its own record so it can be approved and audited;',
	'  do not add punchless rows to stand in for it.',
	'',
	'Accepted values',
	'',
	'employee_number        as seeded on the employment, e.g. NHPMY0002',
	'work_date              YYYY-MM-DD',
	'clock_in / clock_out   HH:mm, 24-hour, local to the timezone on the Settings sheet',
	'',
	'The sample rows below are illustrative. Delete them and paste your own.'
];

function newWorkbook() {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Norbital';
	workbook.lastModifiedBy = 'Norbital';
	workbook.created = EPOCH;
	workbook.modified = EPOCH;
	return workbook;
}

/** One text cell per line, in a single column wide enough to read without wrapping. */
function addReadmeSheet(workbook, lines) {
	const worksheet = workbook.addWorksheet('Read me first');
	worksheet.getColumn(1).width = 118;
	for (const line of lines) worksheet.addRow([line]);
	return worksheet;
}

function addTableSheet(workbook, name, columnWidths, header, rows) {
	const worksheet = workbook.addWorksheet(name);
	columnWidths.forEach((width, index) => {
		worksheet.getColumn(index + 1).width = width;
	});
	worksheet.addRow(header);
	for (const row of rows) worksheet.addRow(row);
	return worksheet;
}

async function writeWorkbook(workbook, targetPath) {
	await workbook.xlsx.writeFile(targetPath);

	// Read back what was shipped, and refuse to call it done if it is not exactly the template.
	const reloaded = new ExcelJS.Workbook();
	await reloaded.xlsx.readFile(targetPath);
	return reloaded;
}

function headersOf(workbook, sheetName) {
	const headerRow = workbook.getWorksheet(sheetName)?.getRow(1);
	const headers = [];
	headerRow?.eachCell({ includeEmpty: true }, (cell) => headers.push(cell.value));
	return headers;
}

const rosterWorkbook = newWorkbook();
addReadmeSheet(rosterWorkbook, ROSTER_README);
addTableSheet(rosterWorkbook, 'Roster', [18, 13, 13], ROSTER_HEADERS, ROSTER_SAMPLE_ROWS);
const rosterShipped = await writeWorkbook(rosterWorkbook, ROSTER_TEMPLATE_PATH);
assert.deepEqual(
	[...rosterShipped.worksheets.map((sheet) => sheet.name)],
	['Read me first', 'Roster']
);
assert.deepEqual(headersOf(rosterShipped, 'Roster'), ROSTER_HEADERS);

const timeWorkbook = newWorkbook();
addReadmeSheet(timeWorkbook, TIME_README);
addTableSheet(timeWorkbook, 'Settings', [22, 34], SETTINGS_ROWS[0], SETTINGS_ROWS.slice(1));
addTableSheet(
	timeWorkbook,
	'Time entries',
	[18, 13, 13, 13],
	TIME_ENTRY_HEADERS,
	TIME_ENTRY_SAMPLE_ROWS
);
const timeShipped = await writeWorkbook(timeWorkbook, TIME_TEMPLATE_PATH);
assert.deepEqual(
	[...timeShipped.worksheets.map((sheet) => sheet.name)],
	['Read me first', 'Settings', 'Time entries']
);
assert.deepEqual(headersOf(timeShipped, 'Time entries'), TIME_ENTRY_HEADERS);

console.log(`${ROSTER_TEMPLATE_PATH}`);
console.log(`  sheets: Read me first, Roster`);
console.log(`  Roster header: ${headersOf(rosterShipped, 'Roster').join(', ')}`);
console.log(`${TIME_TEMPLATE_PATH}`);
console.log(`  sheets: Read me first, Settings, Time entries`);
console.log(`  Time entries header: ${headersOf(timeShipped, 'Time entries').join(', ')}`);
