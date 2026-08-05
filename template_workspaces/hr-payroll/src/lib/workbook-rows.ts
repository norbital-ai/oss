/**
 * Reading an operator's workbook into the JSON an import pipeline declares.
 *
 * The platform does not parse files. `import_data` is arbitrary structured JSON and the browser
 * posts JSON, so turning a spreadsheet into rows is the workspace's job and happens before anything
 * is sent. These helpers are the shared half of that: they know nothing about rosters or punches,
 * only about grids, headers and cells.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY EVERY COMPLAINT IS COLLECTED BEFORE ANY IS RAISED.
 *
 * The platform writes an import in ONE transaction and has no per-row rejection: either the whole
 * file lands or none of it does. A reader that threw on the first bad cell would make the operator
 * discover their file one defect per upload. So a run gathers every problem it can see, names the
 * spreadsheet row each belongs to, and refuses once with the list — which is the same shape the
 * server's own refusals take.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { isCalendarDate, isClockTime } from '@norbital-ai/std/date';

/** A cell after the file format's own wrappers are stripped off. */
export type SheetCell = string | number | boolean | Date | null;
/** One sheet as rows of cells, header row included. */
export type SheetGrid = readonly (readonly SheetCell[])[];
/** Every sheet in the chosen file, keyed by its name. */
export type WorkbookGrids = ReadonlyMap<string, SheetGrid>;

const MINUTES_PER_DAY = 1440;
const PROBLEM_LIMIT = 20;

/**
 * A refusal the operator can act on: a headline, then the rows it names.
 *
 * `message` carries both so that a caller which only knows how to show an error string still shows
 * the rows; `headline` and `problems` stay separate for callers that can lay them out.
 */
export class WorkbookImportError extends Error {
	readonly headline: string;
	readonly problems: readonly string[];

	constructor(headline: string, problems: readonly string[] = []) {
		const shown = problems.slice(0, PROBLEM_LIMIT).map((problem) => `• ${problem}`);
		const remainder =
			problems.length > PROBLEM_LIMIT ? `\n…and ${problems.length - PROBLEM_LIMIT} more.` : '';
		super(problems.length === 0 ? headline : `${headline}\n${shown.join('\n')}${remainder}`);
		this.name = 'WorkbookImportError';
		this.headline = headline;
		this.problems = problems;
	}
}

/**
 * A cell as one of the four things a value can be.
 *
 * Spreadsheet libraries hand back a cell as whatever its formatting made it — a formula and its last
 * computed result, a run of styled text fragments, a hyperlink and its label. All of those are still
 * one value to a reader of the file, so they are unwrapped here rather than in every caller.
 */
export function normalizeCellValue(value: unknown): SheetCell {
	if (value == null) return null;
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'boolean') return value;
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
	if (typeof value !== 'object') return null;

	const record = value as Record<string, unknown>;
	if ('error' in record) return null;
	if ('result' in record) return normalizeCellValue(record.result);
	if ('richText' in record && Array.isArray(record.richText)) {
		return record.richText
			.map((fragment) => String((fragment as { text?: unknown }).text ?? ''))
			.join('');
	}
	if ('text' in record) return normalizeCellValue(record.text);
	if ('formula' in record || 'sharedFormula' in record) return null;
	return null;
}

/**
 * The shape of a loaded spreadsheet this file reads.
 *
 * Structural rather than the library's own type, so the same conversion runs against whichever
 * ExcelJS distribution is at hand — the browser bundle the app ships, or the ordinary package a
 * verification script opens a file with. What the operator's browser does to a workbook is then
 * exactly what a test can do to one.
 */
export interface WorkbookCellLike {
	readonly value: unknown;
}
export interface WorkbookRowLike {
	eachCell(
		options: { includeEmpty: boolean },
		callback: (cell: WorkbookCellLike, columnNumber: number) => void
	): void;
}
export interface WorksheetLike {
	readonly name: string;
	eachRow(
		options: { includeEmpty: boolean },
		callback: (row: WorkbookRowLike, rowNumber: number) => void
	): void;
}
export interface WorkbookLike {
	eachSheet(callback: (worksheet: WorksheetLike, sheetId: number) => void): void;
}

/**
 * Every sheet of a loaded workbook, as grids of plain values.
 *
 * A worksheet is addressed by row and column number, and both skip — an empty row is simply not
 * there. Every gap is filled, so a grid index is the spreadsheet's own row number minus one, which
 * is what lets a refusal name the row the operator is looking at.
 */
export function workbookGrids(workbook: WorkbookLike): WorkbookGrids {
	const grids = new Map<string, SheetGrid>();
	workbook.eachSheet((worksheet) => {
		const rows: SheetCell[][] = [];
		worksheet.eachRow({ includeEmpty: true }, (worksheetRow, rowNumber) => {
			const cells: SheetCell[] = [];
			worksheetRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
				cells[columnNumber - 1] = normalizeCellValue(cell.value);
			});
			rows[rowNumber - 1] = Array.from(
				{ length: cells.length },
				(_, index) => cells[index] ?? null
			);
		});
		grids.set(
			worksheet.name,
			Array.from({ length: rows.length }, (_, index) => rows[index] ?? [])
		);
	});
	return grids;
}

/**
 * A CSV as one grid, honouring RFC 4180 quoting so a quoted comma or newline stays in its cell.
 *
 * A CSV carries no sheet name, so the caller supplies one — `requireSheet` accepts a single-sheet
 * file under any name rather than insisting a format that cannot name a sheet names it correctly.
 */
export function csvGrid(text: string): SheetGrid {
	const rows: SheetCell[][] = [];
	let row: SheetCell[] = [];
	let cell = '';
	let quoted = false;
	const source = text.replace(/^﻿/, '');

	const endCell = (): void => {
		row.push(cell === '' ? null : cell);
		cell = '';
	};
	const endRow = (): void => {
		endCell();
		rows.push(row);
		row = [];
	};

	for (let index = 0; index < source.length; index += 1) {
		const character = source[index]!;
		if (quoted) {
			if (character !== '"') cell += character;
			else if (source[index + 1] === '"') {
				cell += '"';
				index += 1;
			} else quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === ',') endCell();
		else if (character === '\r') continue;
		else if (character === '\n') endRow();
		else cell += character;
	}
	if (cell !== '' || row.length > 0) endRow();
	return rows;
}

/** A header as it is compared: case, surrounding space and separator style do not distinguish two. */
function headerKey(value: SheetCell): string {
	return String(value ?? '')
		.trim()
		.toLowerCase()
		.replaceAll(/[\s-]+/g, '_');
}

function isBlank(cell: SheetCell): boolean {
	return cell == null || (typeof cell === 'string' && cell.trim() === '');
}

function sheetKey(name: string): string {
	return name.trim().toLowerCase();
}

/** The named sheet, or nothing. A caller that must not fall back to "the only sheet" uses this. */
export function findSheet(grids: WorkbookGrids, name: string): SheetGrid | undefined {
	const direct = grids.get(name);
	if (direct != null) return direct;
	const wanted = sheetKey(name);
	for (const [sheetName, grid] of grids) if (sheetKey(sheetName) === wanted) return grid;
	return undefined;
}

/**
 * The named sheet.
 *
 * A single-sheet file is accepted under any name: that is what a CSV is, and refusing one for not
 * being called `Roster` would be pedantry about a format that cannot carry the name.
 */
export function requireSheet(grids: WorkbookGrids, name: string): SheetGrid {
	const found = findSheet(grids, name);
	if (found != null) return found;
	if (grids.size === 1) return [...grids.values()][0]!;
	const names = [...grids.keys()].map((sheetName) => `"${sheetName}"`).join(', ');
	throw new WorkbookImportError(
		`This file has no "${name}" sheet, so there is nothing to import from it.`,
		[`The file contains: ${names}.`, 'Use the import template without renaming its sheets.']
	);
}

/** One data row, with the spreadsheet row number it came from so a refusal can name it. */
export interface SheetRow {
	readonly rowNumber: number;
	readonly cells: ReadonlyMap<string, SheetCell>;
}

export interface SheetTable {
	readonly sheetName: string;
	readonly headers: readonly string[];
	readonly rows: readonly SheetRow[];
}

/**
 * The sheet as a header-keyed table.
 *
 * The header row is the first row that has anything in it, so a template with a title or a note
 * above its table still reads. Rows that are entirely empty are dropped — a spreadsheet's used
 * range routinely runs past the last row anyone typed in.
 */
export function readSheetTable(
	grids: WorkbookGrids,
	sheetName: string,
	requiredHeaders: readonly string[]
): SheetTable {
	const grid = requireSheet(grids, sheetName);
	const headerIndex = grid.findIndex((row) => row.some((cell) => !isBlank(cell)));
	if (headerIndex < 0) {
		throw new WorkbookImportError(`The "${sheetName}" sheet is empty.`);
	}

	const headers = grid[headerIndex]!.map(headerKey);
	const missing = requiredHeaders.filter((header) => !headers.includes(header));
	if (missing.length > 0) {
		throw new WorkbookImportError(
			`The "${sheetName}" sheet is missing column${missing.length === 1 ? '' : 's'} the import needs.`,
			[
				...missing.map((header) => `No "${header}" column.`),
				`Columns found: ${headers.filter((header) => header !== '').join(', ') || '(none)'}.`,
				'Use the import template without renaming its columns.'
			]
		);
	}

	const rows: SheetRow[] = [];
	for (let index = headerIndex + 1; index < grid.length; index += 1) {
		const cells = grid[index]!;
		if (cells.every((cell) => isBlank(cell))) continue;
		rows.push({
			rowNumber: index + 1,
			cells: new Map(headers.map((header, column) => [header, cells[column] ?? null]))
		});
	}
	if (rows.length === 0) {
		throw new WorkbookImportError(
			`The "${sheetName}" sheet has column headers but no rows to import.`
		);
	}
	return { sheetName, headers, rows };
}

function pad(value: number): string {
	return String(value).padStart(2, '0');
}

/**
 * Reads one row's cells, recording what it could not read rather than throwing.
 *
 * Every accessor answers `undefined` for a cell it rejected, so a row keeps being read after its
 * first bad cell and the operator sees all of them at once.
 */
export class RowReader {
	readonly rowNumber: number;
	readonly #cells: ReadonlyMap<string, SheetCell>;
	readonly #problems: string[];
	readonly #identify: (reader: RowReader) => string;

	constructor(row: SheetRow, problems: string[], identify: (reader: RowReader) => string) {
		this.rowNumber = row.rowNumber;
		this.#cells = row.cells;
		this.#problems = problems;
		this.#identify = identify;
	}

	/** `Row 7 (NHPMY0002 on 2026-05-04)` — whatever the caller decided names a row of this sheet. */
	get identity(): string {
		return this.#identify(this);
	}

	raw(column: string): SheetCell {
		return this.#cells.get(column) ?? null;
	}

	reject(column: string, expected: string): undefined {
		const shown = this.text(column);
		this.#problems.push(
			`${this.identity}: ${column} ${shown == null ? 'is empty' : `is "${shown}"`}, expected ${expected}.`
		);
		return undefined;
	}

	/**
	 * The cell as trimmed text, or nothing when it is blank.
	 *
	 * A date the spreadsheet made a real date of reads back as the day it names, so that a refusal
	 * naming the row shows what the operator typed rather than an instant they never wrote.
	 */
	text(column: string): string | undefined {
		const cell = this.raw(column);
		if (isBlank(cell)) return undefined;
		if (cell instanceof Date) return cell.toISOString().replace('T00:00:00.000Z', '');
		const text = String(cell).trim();
		return text === '' ? undefined : text;
	}

	requiredText(column: string): string | undefined {
		return this.text(column) ?? this.reject(column, 'a value');
	}

	/** `YYYY-MM-DD`, whether the cell holds that text or a real date the spreadsheet made of it. */
	calendarDate(column: string): string | undefined {
		const cell = this.raw(column);
		if (isBlank(cell)) return this.reject(column, 'a date as YYYY-MM-DD');
		if (cell instanceof Date) {
			return `${cell.getUTCFullYear()}-${pad(cell.getUTCMonth() + 1)}-${pad(cell.getUTCDate())}`;
		}
		const text = String(cell).trim();
		return isCalendarDate(text) ? text : this.reject(column, 'a date as YYYY-MM-DD');
	}

	/**
	 * `HH:mm`.
	 *
	 * A clock cell that a spreadsheet decided was a time comes back as a date on an epoch of its own,
	 * or as a fraction of a day. Both mean the same wall clock, so both are read.
	 */
	clockTime(column: string): string | undefined {
		const cell = this.raw(column);
		if (isBlank(cell)) return undefined;
		if (cell instanceof Date) return `${pad(cell.getUTCHours())}:${pad(cell.getUTCMinutes())}`;
		if (typeof cell === 'number') {
			if (cell < 0 || cell >= 1) return this.reject(column, 'a local time as HH:mm');
			const minutes = Math.round(cell * MINUTES_PER_DAY);
			return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
		}
		const text = String(cell).trim();
		const padded = /^\d:\d{2}$/.test(text) ? `0${text}` : text;
		const truncated = /^\d{2}:\d{2}:\d{2}$/.test(padded) ? padded.slice(0, 5) : padded;
		return isClockTime(truncated) ? truncated : this.reject(column, 'a local time as HH:mm');
	}

	wholeNumber(column: string): number | undefined {
		const cell = this.raw(column);
		if (isBlank(cell)) return undefined;
		const value = typeof cell === 'number' ? cell : Number(String(cell).trim());
		if (!Number.isInteger(value) || value < 0) {
			return this.reject(column, 'a whole number of minutes, zero or more');
		}
		return value;
	}

	/**
	 * TRUE, FALSE, or neither.
	 *
	 * Empty is not false. The column it reads records whether overtime was authorised, and "nobody
	 * said" is a third answer the collection stores as null — flattening it to false would assert a
	 * refusal that no one made.
	 */
	triStateBoolean(column: string): boolean | undefined {
		const cell = this.raw(column);
		if (isBlank(cell)) return undefined;
		if (typeof cell === 'boolean') return cell;
		if (typeof cell === 'number') {
			if (cell === 1) return true;
			if (cell === 0) return false;
			return this.reject(column, 'TRUE, FALSE or empty');
		}
		switch (String(cell).trim().toLowerCase()) {
			case 'true':
			case 'yes':
			case 'y':
			case '1':
				return true;
			case 'false':
			case 'no':
			case 'n':
			case '0':
				return false;
			default:
				return this.reject(column, 'TRUE, FALSE or empty');
		}
	}

	choice<TChoice extends string>(
		column: string,
		allowed: readonly TChoice[],
		required: boolean
	): TChoice | undefined {
		const text = this.text(column);
		if (text == null) return required ? this.reject(column, allowed.join(', ')) : undefined;
		const match = allowed.find((option) => option.toLowerCase() === text.toLowerCase());
		return match ?? this.reject(column, allowed.join(', '));
	}
}

/**
 * Reads every row, then raises once if anything was rejected.
 *
 * `read` returns the row it built; that row is only kept when the run had nothing to complain about,
 * so a partially-read row can never reach the server.
 */
export function readRows<TRow>(
	table: SheetTable,
	identify: (reader: RowReader) => string,
	read: (reader: RowReader) => TRow
): readonly TRow[] {
	const problems: string[] = [];
	const rows = table.rows.map((row) => read(new RowReader(row, problems, identify)));
	if (problems.length > 0) {
		throw new WorkbookImportError(
			`The "${table.sheetName}" sheet cannot be imported as it stands. Nothing was written — ` +
				'the whole file is refused so it can be corrected and re-imported as one:',
			problems
		);
	}
	return rows;
}
