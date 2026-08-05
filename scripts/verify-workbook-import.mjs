/**
 * The import round trip, on the workbooks that were sent to operators.
 *
 * A real .xlsx is written with the layout of the shipped import templates — the `Read me first`
 * sheet included, dates and clock times stored as text, `overtime_authorized` three-state — then
 * read back through the same conversion the browser runs, and the resulting JSON is handed to the
 * collection's own `+pipelines.ts` handler. So this exercises the whole path the operator's click
 * takes, minus the file dialog and the transport.
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

const ROSTER_HEADERS = [
	'employee_number',
	'work_date',
	'day_type',
	'shift_code',
	'assignment_code',
	'note'
];
const ROSTER_ROWS = [
	['NHPMY0002', '2026-05-01', 'PUBLIC_HOLIDAY', '7.5AM', '', 'Labour Day'],
	['NHPMY0002', '2026-05-02', 'OFF', '7.5AM', '', ''],
	['NHPMY0002', '2026-05-03', 'REST', '7.5AM', 'AMRES', ''],
	['NHPMY0002', '2026-05-04', 'WORK', '7.5AM', '', ''],
	['NHPMY0002', '2026-05-05', 'WORK', '7.5AM', '', ''],
	['NHPMY0023', '2026-05-04', 'WORK', 'AM0830', '', ''],
	['NHPMY0023', '2026-05-05', 'WORK', 'PM2030', '', 'Night rotation']
];

const TIME_ENTRY_HEADERS = [
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
const TIME_ENTRY_ROWS = [
	['NHPMY0002', '2026-05-04', '08:16', '17:10', 60, '', '', '', 'CLOSED', ''],
	['NHPMY0002', '2026-05-05', '08:02', '17:05', 60, '17:30', '19:30', true, 'CLOSED', ''],
	['NHPMY0002', '2026-05-06', '', '', 0, '', '', '', 'CLOSED', 'AL'],
	['NHPMY0023', '2026-05-04', '20:30', '05:15', 45, '', '', '', 'CLOSED', ''],
	['NHPMY0023', '2026-05-05', '20:28', '05:02', 45, '', '', false, 'CLOSED', ''],
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
		company_holidays: [{ date: '2026-05-01', company_id: COMPANY_ID }],
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
	const timeEntryGrids = async (rows) =>
		workbookGrids(
			await gridsOf([
				['Read me first', README],
				['Settings', SETTINGS_ROWS],
				['Time entries', [TIME_ENTRY_HEADERS, ...rows]]
			])
		);

	// ── The roster workbook, from bytes to written rows ────────────────────────────────────────────
	const rosterPayload = rosterImportPayload(await rosterGrids(ROSTER_ROWS), ROSTER_ID);
	assert.equal(rosterPayload.roster_id, ROSTER_ID);
	assert.equal(rosterPayload.rows.length, 7, 'the "Read me first" sheet is not a source of rows');
	assert.deepEqual(rosterPayload.rows[2], {
		employee_number: 'NHPMY0002',
		work_date: '2026-05-03',
		day_type: 'REST',
		shift_code: '7.5AM',
		assignment_code: 'AMRES',
		note: undefined
	});
	assert.equal(rosterPayload.rows[0].note, 'Labour Day');
	assert.equal(
		rosterPayload.rows[0].assignment_code,
		undefined,
		'an empty cell is the absence of a code, which the schema requires to be omitted'
	);

	const written = await rosterPipeline.import.handler({ input: rosterPayload }, rosterApi());
	assert.equal(written.length, 7);
	assert.deepEqual(written[0], {
		employment_id: 'employment:2',
		work_date: '2026-05-01',
		shift_definition_id: 'shift:75',
		roster_id: ROSTER_ID,
		assignment_code: null,
		designation: 'OFF'
	});
	assert.deepEqual(
		written.map((row) => row.designation),
		['OFF', 'OFF', 'REST', 'WORK', 'WORK', 'WORK', 'WORK']
	);
	assert.deepEqual(
		written.at(-1),
		{
			employment_id: 'employment:23',
			work_date: '2026-05-05',
			shift_definition_id: 'shift:pm',
			roster_id: ROSTER_ID,
			assignment_code: null,
			designation: 'WORK'
		},
		'every row resolves to the employment and shift its codes name'
	);

	// ── One bad row refuses the whole file, and says which row ─────────────────────────────────────
	const unknownEmployee = await refusal(async () =>
		rosterPipeline.import.handler(
			{
				input: rosterImportPayload(
					await rosterGrids([...ROSTER_ROWS, ['NHPMY9999', '2026-05-06', 'WORK', '7.5AM', '', '']]),
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
					await rosterGrids([...ROSTER_ROWS, ['NHPMY0002', '2026-06-01', 'WORK', '7.5AM', '', '']]),
					ROSTER_ID
				)
			},
			rosterApi()
		)
	);
	assert.match(outsideMonth, /Roster 2026-05 owns only its own calendar days/);
	assert.match(outsideMonth, /• NHPMY0002 on 2026-06-01/);

	const ungazettedHoliday = await refusal(async () =>
		rosterPipeline.import.handler(
			{
				input: rosterImportPayload(
					await rosterGrids(
						ROSTER_ROWS.map((row) =>
							row[1] === '2026-05-02'
								? [...row.slice(0, 2), 'PUBLIC_HOLIDAY', ...row.slice(3)]
								: row
						)
					),
					ROSTER_ID
				)
			},
			rosterApi()
		)
	);
	assert.match(ungazettedHoliday, /not on the company calendar/);
	assert.match(ungazettedHoliday, /• NHPMY0002 on 2026-05-02/);
	assert.doesNotMatch(
		ungazettedHoliday,
		/2026-05-01/,
		'the gazetted holiday is not complained about'
	);

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
				['NHPMY0002', '04/05/2026', 'WORK', '7.5AM', '', ''],
				['NHPMY0002', '2026-05-05', 'HOLIDAY', '7.5AM', '', ''],
				['', '2026-05-06', 'WORK', '', '', '']
			]),
			ROSTER_ID
		)
	);
	assert.match(badCells, /Nothing was written/);
	assert.match(badCells, /Row 2 \(NHPMY0002 on 04\/05\/2026\): work_date is "04\/05\/2026"/);
	assert.match(badCells, /Row 3 \(NHPMY0002 on 2026-05-05\): day_type is "HOLIDAY"/);
	assert.match(badCells, /Row 4 \(2026-05-06\): employee_number is empty/);
	assert.match(badCells, /Row 4 \(2026-05-06\): shift_code is empty/);

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
	assert.match(missingColumn, /missing columns the import needs/);
	assert.match(missingColumn, /No "day_type" column/);
	assert.match(missingColumn, /No "shift_code" column/);

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
						'NHPMY0002,2026-05-04,WORK,7.5AM,,"Covers, then hands over"\n'
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
			note: 'Covers, then hands over'
		}
	]);

	// ── The time-entry workbook ────────────────────────────────────────────────────────────────────
	const timePayload = timeEntryImportPayload(await timeEntryGrids(TIME_ENTRY_ROWS));
	assert.equal(
		timePayload.timezone,
		'Asia/Kuala_Lumpur',
		'the zone comes from the Settings sheet, never from the browser'
	);
	assert.equal(timePayload.rows.length, 6);
	assert.deepEqual(timePayload.rows[1], {
		employee_number: 'NHPMY0002',
		work_date: '2026-05-05',
		clock_in: '08:02',
		clock_out: '17:05',
		break_minutes: 60,
		overtime_in: '17:30',
		overtime_out: '19:30',
		overtime_authorized: true,
		state: 'CLOSED',
		reason: undefined
	});
	assert.equal(timePayload.rows[0].overtime_authorized, undefined, 'empty is not FALSE');
	assert.equal(timePayload.rows[4].overtime_authorized, false);
	assert.equal(timePayload.rows[5].clock_out, undefined, 'an unclosed punch stays unclosed');

	/*
	 * A row the SHIPPED template contains is refused: `2026-05-06` records a leave day as CLOSED with
	 * no punches, and both the import pipeline and the `time_entries` create hook require a CLOSED
	 * entry to carry both stamps. Pinned rather than worked around — the workbook in the operator's
	 * inbox and the rule the collection enforces disagree, and one of the two has to be changed by
	 * someone who owns that decision. Until then this states exactly what an operator will see.
	 */
	const shippedLeaveRow = await refusal(async () =>
		timeEntryPipeline.import.handler({ input: timePayload }, timeEntryApi())
	);
	assert.match(shippedLeaveRow, /marked CLOSED but are missing a clock stamp/);
	assert.match(shippedLeaveRow, /• NHPMY0002 on 2026-05-06/);

	const consistentRows = TIME_ENTRY_ROWS.map((row) =>
		row[1] === '2026-05-06' && row[0] === 'NHPMY0002'
			? [...row.slice(0, 8), '', ...row.slice(9)]
			: row
	);
	const landed = await timeEntryPipeline.import.handler(
		{ input: timeEntryImportPayload(await timeEntryGrids(consistentRows)) },
		timeEntryApi()
	);
	assert.equal(landed.length, 6);
	assert.deepEqual(landed[0], {
		employment_id: 'employment:2',
		work_date: '2026-05-04',
		clock_in: new Date('2026-05-04T00:16:00.000Z'),
		clock_out: new Date('2026-05-04T09:10:00.000Z'),
		break_minutes: 60,
		state: 'CLOSED',
		overtime_authorized: null,
		overtime_in: null,
		overtime_out: null
	});
	assert.deepEqual(
		landed[3],
		{
			employment_id: 'employment:23',
			work_date: '2026-05-04',
			clock_in: new Date('2026-05-04T12:30:00.000Z'),
			clock_out: new Date('2026-05-04T21:15:00.000Z'),
			break_minutes: 45,
			state: 'CLOSED',
			overtime_authorized: null,
			overtime_in: null,
			overtime_out: null
		},
		'a night shift closes on the next calendar day, eight hours behind UTC'
	);
	assert.equal(
		landed[2].state,
		'OPEN',
		'a day with no punches derives OPEN once its state is blank'
	);
	assert.equal(landed[5].clock_out, null);
	assert.equal(
		landed[4].overtime_authorized,
		false,
		'a recorded refusal is not the same as silence'
	);

	const unknownPuncher = await refusal(async () =>
		timeEntryPipeline.import.handler(
			{
				input: timeEntryImportPayload(
					await timeEntryGrids([
						...consistentRows,
						['NHPMY9999', '2026-05-04', '08:00', '17:00', 60, '', '', '', 'CLOSED', '']
					])
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
					await timeEntryGrids([
						['NHPMY0002', '2026-05-04', '08:00', '17:00', 60, '17:30', '', '', 'CLOSED', '']
					])
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
				['NHPMY0002', '2026-05-04', '8.30am', '17:00', 'sixty', '', '', 'maybe', 'DONE', '']
			])
		)
	);
	assert.match(badClock, /clock_in is "8\.30am", expected a local time as HH:mm/);
	assert.match(badClock, /break_minutes is "sixty"/);
	assert.match(badClock, /overtime_authorized is "maybe", expected TRUE, FALSE or empty/);
	assert.match(badClock, /state is "DONE", expected OPEN, CLOSED/);

	console.log('workbook import: roster and time-entry templates round trip, and refuse by row.');
} finally {
	await vite.close();
}
