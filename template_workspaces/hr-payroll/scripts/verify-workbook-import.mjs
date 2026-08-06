/**
 * The import round trip, on the workbooks that were sent to operators.
 *
 * A real .xlsx is written with the layout of the shipped import templates — the `Read me first`
 * sheet included, dates and clock times stored as text — then read back through the same conversion
 * the browser runs, and the resulting JSON is handed to the collection's own `+pipelines.ts`
 * handler. So this exercises the whole path the operator's click takes, minus the file dialog and
 * the transport.
 *
 * The roster sheet carries three columns and no day type: a row naming a shift is a working day,
 * a row leaving the shift cell blank is a rest day, and the reader derives which of the two a row
 * is. A blank shift_code is therefore a rest day spelled out, not a defect to refuse — the file
 * cannot name a day type that disagrees with its shift, because it does not name one at all.
 *
 * The time-entry sheet carries four columns, one row per person per day. The file issued before
 * this one carried more — break minutes, overtime punches, a state, a reason, and an
 * `overtime_authorized` the collection no longer has — and a sheet shaped like that still imports
 * here, so an operator does not have to be reissued a workbook to keep working.
 *
 * The refusal cases matter as much as the happy one: the platform writes an import in a single
 * transaction and has no per-row rejection, so a bad row must refuse the WHOLE file and say which
 * row it was.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({
	root,
	appType: 'custom',
	logLevel: 'silent',
	server: { middlewareMode: true }
});

/** The workbook as the operator's browser sees it: written to bytes, then loaded back. */
async function gridsOf(sheets) {
	const workbook = new ExcelJS.Workbook();
	for (const [name, rows] of sheets) {
		const worksheet = workbook.addWorksheet(name);
		for (const row of rows) worksheet.addRow(row);
	}
	const reloaded = new ExcelJS.Workbook();
	await reloaded.xlsx.load(await workbook.xlsx.writeBuffer());
	return reloaded;
}

/** The `Read me first` sheet every shipped template opens with, which the import must ignore. */
const README = [['Roster import — planned assignment'], [], ['One row per person per day.']];

const ROSTER_HEADERS = ['employee_number', 'work_date', 'shift_code'];
const ROSTER_ROWS = [
	['NHPMY0002', '2026-05-01', '7.5AM'],
	['NHPMY0002', '2026-05-02', '7.5AM'],
	['NHPMY0002', '2026-05-03', ''],
	['NHPMY0002', '2026-05-04', '7.5AM'],
	['NHPMY0002', '2026-05-05', '7.5AM'],
	['NHPMY0023', '2026-05-04', 'AM0830'],
	['NHPMY0023', '2026-05-05', 'PM2030'],
	['NHPMY0023', '2026-05-06', '']
];

/*
 * The shape of the file issued before this one: six columns, the day type declared rather than
 * derived. The declaration is no longer read — the shift cell decides — but the file itself keeps
 * importing, and its assignment and note columns keep landing.
 */
const LEGACY_ROSTER_HEADERS = [
	'employee_number',
	'work_date',
	'day_type',
	'shift_code',
	'assignment_code',
	'note'
];
const LEGACY_ROSTER_ROWS = [
	['NHPMY0002', '2026-05-04', 'WORK', '7.5AM', '', 'Covers, then hands over'],
	['NHPMY0002', '2026-05-05', 'REST', '', '', ''],
	['NHPMY0023', '2026-05-06', 'REST', 'AM0830', 'AMRES', '']
];

const TIME_ENTRY_HEADERS = ['employee_number', 'work_date', 'clock_in', 'clock_out'];
const TIME_ENTRY_ROWS = [
	['NHPMY0002', '2026-05-04', '08:16', '17:10'],
	['NHPMY0002', '2026-05-05', '08:02', '17:05'],
	['NHPMY0023', '2026-05-04', '20:30', '05:15'],
	['NHPMY0023', '2026-05-05', '20:28', '05:02'],
	['NHPMY0023', '2026-05-06', '20:31', '']
];

/*
 * The shape of the file issued before this one: ten columns, `overtime_authorized` among them.
 * Overtime is now calculated in the payroll run rather than approved on the attendance row, and
 * the column is gone from the collection — so what this pins is that the OLD file keeps importing,
 * with that column read by nobody and the rest landing as before.
 */
const LEGACY_TIME_ENTRY_HEADERS = [
	'employee_number',
	'work_date',
	'clock_in',
	'clock_out',
	'break_minutes',
	'overtime_in',
	'overtime_out',
	'overtime_authorized',
	'state',
	'reason'
];
const LEGACY_TIME_ENTRY_ROWS = [
	['NHPMY0002', '2026-05-04', '08:16', '17:10', 60, '', '', '', 'CLOSED', ''],
	['NHPMY0002', '2026-05-05', '08:02', '17:05', 60, '17:30', '19:30', true, 'CLOSED', ''],
	['NHPMY0023', '2026-05-06', '20:31', '', 0, '', '', '', 'OPEN', '']
];
const SETTINGS_ROWS = [
	['Setting', 'Value'],
	['timezone', 'Asia/Kuala_Lumpur'],
	[],
	['', 'An IANA timezone name.']
];

const ROSTER_ID = 'roster:2026-05';
const COMPANY_ID = 'company:1';

function matches(row, where = {}) {
	return Object.entries(where).every(([column, condition]) => {
		if (condition == null) return true;
		if ('eq' in condition) return String(row[column]) === String(condition.eq);
		if ('in' in condition) return condition.in.map(String).includes(String(row[column]));
		if ('isNull' in condition) return (row[column] == null) === condition.isNull;
		throw new Error(`The stub does not implement ${JSON.stringify(condition)} on ${column}.`);
	});
}

/** A stand-in for the workspace tables the pipelines resolve names against. */
function stubApi(tables) {
	const query = Object.fromEntries(
		Object.entries(tables).map(([name, rows]) => [
			name,
			{
				findFirst: async ({ where } = {}) => rows.find((row) => matches(row, where)) ?? null,
				findMany: async ({ where } = {}) => rows.filter((row) => matches(row, where))
			}
		])
	);
	return { db: { query } };
}

function rosterApi(overrides = {}) {
	return stubApi({
		rosters: [
			{
				norbital_id: ROSTER_ID,
				month: '2026-05',
				published_at: null,
				company_id: COMPANY_ID,
				...overrides.roster
			}
		],
		employments: [
			{ norbital_id: 'employment:2', employee_number: 'NHPMY0002', company_id: COMPANY_ID },
			{ norbital_id: 'employment:23', employee_number: 'NHPMY0023', company_id: COMPANY_ID }
		],
		shift_definitions: [
			{ norbital_id: 'shift:75', code: '7.5AM', company_id: COMPANY_ID },
			{ norbital_id: 'shift:am', code: 'AM0830', company_id: COMPANY_ID },
			{ norbital_id: 'shift:pm', code: 'PM2030', company_id: COMPANY_ID }
		],
		roster_entries: overrides.existingEntries ?? []
	});
}

function timeEntryApi(overrides = {}) {
	return stubApi({
		employments: [
			{ norbital_id: 'employment:2', employee_number: 'NHPMY0002', company_id: COMPANY_ID },
			{ norbital_id: 'employment:23', employee_number: 'NHPMY0023', company_id: COMPANY_ID }
		],
		time_entries: overrides.existingEntries ?? []
	});
}

async function refusal(run) {
	try {
		await run();
	} catch (error) {
		return error.message;
	}
	throw new assert.AssertionError({
		message: 'Expected the import to be refused, but it was not.'
	});
}

try {
	const { rosterImportPayload } = await vite.ssrLoadModule(
		'/src/collections/roster_entries/lib/import-workbook.ts'
	);
	const { timeEntryImportPayload } = await vite.ssrLoadModule(
		'/src/collections/time_entries/lib/import-workbook.ts'
	);
	const { workbookGrids, csvGrid } = await vite.ssrLoadModule('/src/lib/workbook-rows.ts');
	const rosterPipeline = (await vite.ssrLoadModule('/src/collections/roster_entries/+pipelines.ts'))
		.default;
	const timeEntryPipeline = (
		await vite.ssrLoadModule('/src/collections/time_entries/+pipelines.ts')
	).default;

	const rosterGrids = async (rows) =>
		workbookGrids(
			await gridsOf([
				['Read me first', README],
				['Roster', [ROSTER_HEADERS, ...rows]]
			])
		);
	const timeEntryGrids = async (rows, headers = TIME_ENTRY_HEADERS) =>
		workbookGrids(
			await gridsOf([
				['Read me first', README],
				['Settings', SETTINGS_ROWS],
				['Time entries', [headers, ...rows]]
			])
		);

	// ── The roster workbook, from bytes to written rows ────────────────────────────────────────────
	const rosterPayload = rosterImportPayload(await rosterGrids(ROSTER_ROWS), ROSTER_ID);
	assert.equal(rosterPayload.roster_id, ROSTER_ID);
	assert.equal(rosterPayload.rows.length, 8, 'the "Read me first" sheet is not a source of rows');
	assert.deepEqual(
		rosterPayload.rows[0],
		{
			employee_number: 'NHPMY0002',
			work_date: '2026-05-01',
			day_type: 'WORK',
			shift_code: '7.5AM',
			assignment_code: undefined,
			note: undefined
		},
		'a row naming a shift reads as a working day on that shift'
	);
	assert.deepEqual(
		rosterPayload.rows[2],
		{
			employee_number: 'NHPMY0002',
			work_date: '2026-05-03',
			day_type: 'REST',
			shift_code: undefined,
			assignment_code: undefined,
			note: undefined
		},
		'a blank shift cell is not a defect — it is how the sheet spells a rest day'
	);

	const written = await rosterPipeline.import.handler({ input: rosterPayload }, rosterApi());
	assert.equal(written.length, 8);
	assert.deepEqual(
		written.map((row) => row.designation),
		['WORK', 'WORK', 'REST', 'WORK', 'WORK', 'WORK', 'WORK', 'REST'],
		'the day type the reader derived is the designation the entry is stored under'
	);
	assert.deepEqual(
		written.map((row) => row.shift_definition_id),
		['shift:75', 'shift:75', null, 'shift:75', 'shift:75', 'shift:am', 'shift:pm', null],
		'only a working row resolves a shift; a rest day schedules nothing'
	);
	assert.deepEqual(
		written.at(-1),
		{
			employment_id: 'employment:23',
			work_date: '2026-05-06',
			shift_definition_id: null,
			roster_id: ROSTER_ID,
			assignment_code: null,
			designation: 'REST'
		},
		'a row with a blank shift cell lands as a rest day — the whole file imported, so a missing ' +
			'shift_code is no longer an error concept, only the derivation of a REST day'
	);

	/*
	 * The file issued before this one keeps importing: its `day_type` column is read by nobody —
	 * the shift cell decides — while its assignment and note columns keep landing. Note the third
	 * row: the old habit of repeating the ordinary shift on a rest day now reads as a WORKING day,
	 * because a named shift is exactly what a working day is under the derivation.
	 */
	const legacyRoster = rosterImportPayload(
		workbookGrids(
			await gridsOf([
				['Read me first', README],
				['Roster', [LEGACY_ROSTER_HEADERS, ...LEGACY_ROSTER_ROWS]]
			])
		),
		ROSTER_ID
	);
	assert.deepEqual(
		legacyRoster.rows,
		[
			{
				employee_number: 'NHPMY0002',
				work_date: '2026-05-04',
				day_type: 'WORK',
				shift_code: '7.5AM',
				assignment_code: undefined,
				note: 'Covers, then hands over'
			},
			{
				employee_number: 'NHPMY0002',
				work_date: '2026-05-05',
				day_type: 'REST',
				shift_code: undefined,
				assignment_code: undefined,
				note: undefined
			},
			{
				employee_number: 'NHPMY0023',
				work_date: '2026-05-06',
				day_type: 'WORK',
				shift_code: 'AM0830',
				assignment_code: 'AMRES',
				note: undefined
			}
		],
		'the declared day_type is ignored in favour of the shift cell, and the extra columns land'
	);

	// ── One bad row refuses the whole file, and says which row ─────────────────────────────────────
	const unknownEmployee = await refusal(async () =>
		rosterPipeline.import.handler(
			{
				input: rosterImportPayload(
					await rosterGrids([...ROSTER_ROWS, ['NHPMY9999', '2026-05-06', '7.5AM']]),
					ROSTER_ID
				)
			},
			rosterApi()
		)
	);
	assert.match(unknownEmployee, /not employed by this company/);
	assert.match(unknownEmployee, /NHPMY9999/);
	assert.doesNotMatch(
		unknownEmployee,
		/NHPMY0002/,
		'only the offending number is named — the other rows are not at fault'
	);

	const outsideMonth = await refusal(async () =>
		rosterPipeline.import.handler(
			{
				input: rosterImportPayload(
					await rosterGrids([...ROSTER_ROWS, ['NHPMY0002', '2026-06-01', '7.5AM']]),
					ROSTER_ID
				)
			},
			rosterApi()
		)
	);
	assert.match(outsideMonth, /Roster 2026-05 owns only its own calendar days/);
	assert.match(outsideMonth, /• NHPMY0002 on 2026-06-01/);

	const publishedMonth = await refusal(async () =>
		rosterPipeline.import.handler(
			{ input: rosterImportPayload(await rosterGrids(ROSTER_ROWS), ROSTER_ID) },
			rosterApi({ roster: { published_at: new Date('2026-04-20T00:00:00.000Z') } })
		)
	);
	assert.match(publishedMonth, /is published, so its entries are fixed/);

	const alreadyPresent = await refusal(async () =>
		rosterPipeline.import.handler(
			{ input: rosterImportPayload(await rosterGrids(ROSTER_ROWS), ROSTER_ID) },
			rosterApi({
				existingEntries: [{ employment_id: 'employment:2', work_date: '2026-05-04' }]
			})
		)
	);
	assert.match(alreadyPresent, /already have a roster entry/);
	assert.match(alreadyPresent, /• NHPMY0002 on 2026-05-04/);

	// ── Cells the browser refuses before anything is sent ──────────────────────────────────────────
	const badCells = await refusal(async () =>
		rosterImportPayload(
			await rosterGrids([
				['NHPMY0002', '04/05/2026', '7.5AM'],
				['NHPMY0023', '', 'PM2030'],
				['', '2026-05-06', '']
			]),
			ROSTER_ID
		)
	);
	assert.match(badCells, /Nothing was written/);
	assert.match(badCells, /Row 2 \(NHPMY0002 on 04\/05\/2026\): work_date is "04\/05\/2026"/);
	assert.match(badCells, /Row 3 \(NHPMY0023\): work_date is empty/);
	assert.match(badCells, /Row 4 \(2026-05-06\): employee_number is empty/);
	assert.doesNotMatch(
		badCells,
		/shift_code/,
		'the third row leaves shift_code blank and is not complained about — it derives REST'
	);

	const renamedColumns = workbookGrids(
		await gridsOf([
			[
				'Roster',
				[
					['employee_number', 'work_date'],
					['NHPMY0002', '2026-05-04']
				]
			]
		])
	);
	const missingColumn = await refusal(async () => rosterImportPayload(renamedColumns, ROSTER_ID));
	assert.match(missingColumn, /missing column the import needs/);
	assert.match(missingColumn, /No "shift_code" column/);
	assert.doesNotMatch(
		missingColumn,
		/day_type/,
		'the day type is derived from the shift cell, so it is not demanded of the sheet'
	);

	const wrongSheet = await refusal(async () =>
		rosterImportPayload(
			workbookGrids(
				await gridsOf([
					['Read me first', README],
					['Sheet1', [ROSTER_HEADERS, ...ROSTER_ROWS]]
				])
			),
			ROSTER_ID
		)
	);
	assert.match(wrongSheet, /has no "Roster" sheet/);
	assert.match(wrongSheet, /"Read me first", "Sheet1"/);

	// ── A CSV is one sheet under any name ──────────────────────────────────────────────────────────
	const csvPayload = rosterImportPayload(
		new Map([
			[
				'roster.csv',
				csvGrid(
					`${ROSTER_HEADERS.join(',')}\n` +
						'NHPMY0002,2026-05-04,7.5AM\n' +
						'NHPMY0002,2026-05-05,\n'
				)
			]
		]),
		ROSTER_ID
	);
	assert.deepEqual(csvPayload.rows, [
		{
			employee_number: 'NHPMY0002',
			work_date: '2026-05-04',
			day_type: 'WORK',
			shift_code: '7.5AM',
			assignment_code: undefined,
			note: undefined
		},
		{
			employee_number: 'NHPMY0002',
			work_date: '2026-05-05',
			day_type: 'REST',
			shift_code: undefined,
			assignment_code: undefined,
			note: undefined
		}
	]);

	// ── The time-entry workbook ────────────────────────────────────────────────────────────────────
	const timePayload = timeEntryImportPayload(await timeEntryGrids(TIME_ENTRY_ROWS));
	assert.equal(
		timePayload.timezone,
		'Asia/Kuala_Lumpur',
		'the zone comes from the Settings sheet, never from the browser'
	);
	assert.equal(timePayload.rows.length, 5);
	assert.deepEqual(
		timePayload.rows[1],
		{
			employee_number: 'NHPMY0002',
			work_date: '2026-05-05',
			clock_in: '08:02',
			clock_out: '17:05',
			break_minutes: undefined,
			overtime_in: undefined,
			overtime_out: undefined,
			state: undefined,
			reason: undefined
		},
		'a four-column row reads as punches alone — everything else the pipeline derives'
	);
	assert.equal(timePayload.rows[4].clock_out, undefined, 'an unclosed punch stays unclosed');

	const landed = await timeEntryPipeline.import.handler({ input: timePayload }, timeEntryApi());
	assert.equal(landed.length, 5);
	assert.deepEqual(
		landed[0],
		{
			employment_id: 'employment:2',
			work_date: '2026-05-04',
			clock_in: new Date('2026-05-04T00:16:00.000Z'),
			clock_out: new Date('2026-05-04T09:10:00.000Z'),
			break_minutes: 0,
			state: 'CLOSED',
			overtime_in: null,
			overtime_out: null
		},
		'both clocks present close the entry, and a break nobody wrote lands as none'
	);
	assert.deepEqual(
		landed[2],
		{
			employment_id: 'employment:23',
			work_date: '2026-05-04',
			clock_in: new Date('2026-05-04T12:30:00.000Z'),
			clock_out: new Date('2026-05-04T21:15:00.000Z'),
			break_minutes: 0,
			state: 'CLOSED',
			overtime_in: null,
			overtime_out: null
		},
		'a night shift closes on the next calendar day, eight hours behind UTC'
	);
	assert.equal(landed[4].state, 'OPEN', 'a row missing its closing punch derives OPEN');
	assert.equal(landed[4].clock_out, null);

	/*
	 * The file issued before this one keeps importing: the columns the reader names land as before,
	 * and `overtime_authorized` — retired, read by nobody — is dropped on the way in rather than
	 * refused. Nonsense in a column nobody reads is not a reason to refuse a file.
	 */
	const legacyTime = timeEntryImportPayload(
		await timeEntryGrids(LEGACY_TIME_ENTRY_ROWS, LEGACY_TIME_ENTRY_HEADERS)
	);
	assert.deepEqual(
		legacyTime.rows[1],
		{
			employee_number: 'NHPMY0002',
			work_date: '2026-05-05',
			clock_in: '08:02',
			clock_out: '17:05',
			break_minutes: 60,
			overtime_in: '17:30',
			overtime_out: '19:30',
			state: 'CLOSED',
			reason: undefined
		},
		'a row of the already-issued workbook reads as punches, break and overtime pair'
	);
	assert.ok(
		legacyTime.rows.every((row) => !('overtime_authorized' in row)),
		'the retired column is dropped on the way in, not turned into a value'
	);
	const legacyLanded = await timeEntryPipeline.import.handler(
		{ input: legacyTime },
		timeEntryApi()
	);
	assert.deepEqual(
		legacyLanded[1],
		{
			employment_id: 'employment:2',
			work_date: '2026-05-05',
			clock_in: new Date('2026-05-05T00:02:00.000Z'),
			clock_out: new Date('2026-05-05T09:05:00.000Z'),
			break_minutes: 60,
			state: 'CLOSED',
			overtime_in: new Date('2026-05-05T09:30:00.000Z'),
			overtime_out: new Date('2026-05-05T11:30:00.000Z')
		},
		"the overtime pair the old file recorded still lands as instants in the file's own zone"
	);

	const unknownPuncher = await refusal(async () =>
		timeEntryPipeline.import.handler(
			{
				input: timeEntryImportPayload(
					await timeEntryGrids([...TIME_ENTRY_ROWS, ['NHPMY9999', '2026-05-04', '08:00', '17:00']])
				)
			},
			timeEntryApi()
		)
	);
	assert.match(unknownPuncher, /not on file/);
	assert.match(unknownPuncher, /• NHPMY9999/);

	const halfOvertime = await refusal(async () =>
		timeEntryPipeline.import.handler(
			{
				input: timeEntryImportPayload(
					await timeEntryGrids(
						[['NHPMY0002', '2026-05-04', '08:00', '17:00', 60, '17:30', '', '', 'CLOSED', '']],
						LEGACY_TIME_ENTRY_HEADERS
					)
				)
			},
			timeEntryApi()
		)
	);
	assert.match(halfOvertime, /only one half of the overtime punch pair/);
	assert.match(halfOvertime, /• NHPMY0002 on 2026-05-04/);

	const noTimezone = await refusal(async () =>
		timeEntryImportPayload(
			workbookGrids(await gridsOf([['Time entries', [TIME_ENTRY_HEADERS, ...TIME_ENTRY_ROWS]]]))
		)
	);
	assert.match(noTimezone, /does not say which timezone/);

	const badClock = await refusal(async () =>
		timeEntryImportPayload(
			await timeEntryGrids([
				['NHPMY0002', '2026-05-04', '8.30am', '17:00'],
				['NHPMY0023', '05/05/2026', '20:30', '05:15']
			])
		)
	);
	assert.match(badClock, /clock_in is "8\.30am", expected a local time as HH:mm/);
	assert.match(badClock, /work_date is "05\/05\/2026", expected a date as YYYY-MM-DD/);

	console.log('workbook import: roster and time-entry templates round trip, and refuse by row.');
} finally {
	await vite.close();
}
