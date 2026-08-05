/**
 * The browser half of a collection import: choose a file, read it, post the JSON, report the answer.
 *
 * It hangs off the same collection actions menu as the exports — `importPipelines` on
 * `CollectionTable`, beside `exportPipelines` — so the operator sends a file back through the
 * button they downloaded one from.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE FILE IS PARSED HERE AND NOT ON THE SERVER.
 *
 * `import_data` is arbitrary structured JSON: the platform hands the pipeline whatever the caller
 * posted, and never opens a spreadsheet. So the workbook is read in the browser and the pipeline is
 * given rows. That split is also why the pipeline stays the only place that resolves anything —
 * employee numbers, shift codes, holidays and timezones are the server's, checked against the
 * company the records belong to, not against whatever this browser happens to have loaded.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import ExcelJSBrowser from 'exceljs/dist/exceljs.bare.min.js';
import { importCollectionRecords } from '@norbital-ai/pod/client';
import { toast } from 'svelte-sonner';
import {
	normalizeCellValue,
	WorkbookImportError,
	type SheetCell,
	type WorkbookGrids
} from '../workbook-rows.js';

const ACCEPTED_FILE_TYPES = '.xlsx,.csv';
const FAILURE_TOAST_MS = 20_000;

/**
 * Opens the operator's file picker and resolves with their choice, or nothing if they cancelled.
 *
 * The input is never attached to the page. A hidden control in the layout would be one more thing
 * that can be left behind by an unmounted table; this one lives exactly as long as the question.
 */
export async function pickWorkbookFile(): Promise<File | null> {
	if (typeof document === 'undefined') {
		throw new Error('A workbook can only be chosen in a browser.');
	}
	return new Promise<File | null>((resolve) => {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = ACCEPTED_FILE_TYPES;
		let settled = false;
		const finish = (file: File | null): void => {
			if (settled) return;
			settled = true;
			resolve(file);
		};
		input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
		// Dismissing the dialog fires `cancel`; without it a cancelled run would hang on this promise
		// and leave the pipeline's button spinning until the page was reloaded.
		input.addEventListener('cancel', () => finish(null), { once: true });
		input.click();
	});
}

/** A CSV row, honouring RFC 4180 quoting so a quoted comma or newline stays inside its cell. */
function parseCsv(text: string): readonly (readonly SheetCell[])[] {
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

/**
 * Every sheet in the chosen file, as grids of plain values.
 *
 * ExcelJS's browser distribution is the one the payroll workbook is already written with, so
 * reading costs no new dependency. A CSV has one sheet and no name of its own, so it takes the
 * file's — `requireSheet` accepts a single-sheet file under any name.
 */
export async function readWorkbookGrids(file: File): Promise<WorkbookGrids> {
	const grids = new Map<string, readonly (readonly SheetCell[])[]>();
	if (file.name.toLowerCase().endsWith('.csv')) {
		grids.set(file.name, parseCsv(await file.text()));
		return grids;
	}

	const workbook = new ExcelJSBrowser.Workbook();
	try {
		await workbook.xlsx.load(await file.arrayBuffer());
	} catch (cause) {
		throw new WorkbookImportError(`"${file.name}" could not be opened as a spreadsheet.`, [
			'Save it as .xlsx or .csv and try again.',
			cause instanceof Error ? cause.message : String(cause)
		]);
	}

	// A worksheet is addressed by row and column number, and both skip: an empty row is simply not
	// there. Every gap is filled so that a grid index is the spreadsheet's own row number minus one,
	// which is what lets a refusal name the row the operator is looking at.
	workbook.eachSheet((worksheet) => {
		const rows: SheetCell[][] = [];
		worksheet.eachRow({ includeEmpty: true }, (worksheetRow, rowNumber) => {
			const cells: SheetCell[] = [];
			worksheetRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
				cells[columnNumber - 1] = normalizeCellValue(cell.value);
			});
			rows[rowNumber - 1] = Array.from({ length: cells.length }, (_, index) => cells[index] ?? null);
		});
		grids.set(
			worksheet.name,
			Array.from({ length: rows.length }, (_, index) => rows[index] ?? [])
		);
	});
	return grids;
}

/**
 * Shows a refusal as its headline and the rows it names.
 *
 * Both halves of the import refuse the same way: the reader lists the cells it could not read, and
 * the pipeline lists the rows the company's own records contradict. Either arrives as a headline
 * followed by a bulleted list, so the first line becomes the toast and the rest its detail rather
 * than one unreadable run of text.
 */
function reportImportFailure(fallbackHeadline: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const [headline = '', ...detail] = message.split('\n');
	toast.error(headline.trim() === '' ? fallbackHeadline : headline.trim(), {
		description: detail.join('\n').trim() || undefined,
		descriptionClass: 'whitespace-pre-line',
		duration: FAILURE_TOAST_MS
	});
}

export interface WorkbookImportOptions {
	readonly collectionName: string;
	/** Names the thing being imported in the toasts: "roster rows", "time entries". */
	readonly recordLabel: string;
	/** Turns the chosen file into the JSON this collection's import pipeline declares. */
	buildPayload(grids: WorkbookGrids): unknown;
}

/**
 * Runs one import end to end and reports it.
 *
 * Failures are shown here rather than rethrown. `CollectionTable` catches what a pipeline throws
 * and toasts `error.message`, which for these refusals is a headline and a bulleted list of rows
 * collapsed into a single line — so this handles its own and hands the caller a quiet return.
 */
export async function runWorkbookImport(options: WorkbookImportOptions): Promise<void> {
	const file = await pickWorkbookFile();
	if (file == null) return;
	try {
		const payload = options.buildPayload(await readWorkbookGrids(file));
		const created = await importCollectionRecords({
			collection_name: options.collectionName,
			import_data: payload
		});
		toast.success(`Imported ${created.length} ${options.recordLabel} from ${file.name}.`);
	} catch (error) {
		reportImportFailure(`${file.name} could not be imported.`, error);
	}
}
