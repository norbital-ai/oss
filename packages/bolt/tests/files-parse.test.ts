// engine/files/parse.ts, pure: a file sync's built-in parsers (spec §3.3) and which parser an upload is read with.
import { describe, expect, it } from '@effect/vitest';
import { csvOf } from '@norbital-ai/std/csv';
import type { InputFields } from '../src/decl/fields.ts';
import {
	acceptOf,
	parseBuiltin,
	parserFor,
	parsersOf,
	type Parser
} from '../src/engine/files/parse.ts';
import { xlsxOf } from '../src/engine/files/xlsx.ts';

const columns: InputFields = {
	person: { kind: 'text', label: 'Employee' },
	day: { kind: 'date', label: 'Date' },
	start: { kind: 'time', optional: true },
	at: { kind: 'instant', optional: true },
	hours: { kind: 'int', optional: true },
	paid: { kind: 'bool', optional: true }
};
const text = (s: string) => new TextEncoder().encode(s);
const parse = (parser: 'xlsx' | 'csv' | 'tsv' | 'json' | 'ics', bytes: Uint8Array, tz = 'UTC') =>
	parseBuiltin(parser, bytes, columns, { required: ['person', 'day'], tz });

describe('built-in parsers', () => {
	it('xlsx: headers by name or label, any case; Excel serials as dates, times and instants; $at is the sheet row', () => {
		const book = xlsxOf([
			['EMPLOYEE', 'date', 'Start', 'at', 'hours', 'Paid', 'ignored'],
			['ann', 46023, 0.375, 46023.5, '8', 'yes', 'x'],
			[null, null],
			['bob', '2026-01-03', null, null, 7, false]
		]);
		expect(parse('xlsx', book, 'Asia/Singapore')).toEqual({
			records: [
				{
					person: 'ann',
					day: '2026-01-01',
					start: '09:00',
					at: '2026-01-01T04:00:00.000Z',
					hours: 8,
					paid: true,
					$at: 2
				},
				{ person: 'bob', day: '2026-01-03', hours: 7, paid: false, $at: 4 }
			],
			findings: []
		});
	});

	it('a sheet without a required column is refused at the header row, by its label', () => {
		expect(parse('xlsx', xlsxOf([['Employee', 'hours']]))).toEqual({
			records: [],
			findings: [
				{ at: 1, field: 'Date', message: 'The file has no such column.', severity: 'refuse' }
			]
		});
	});

	it('csv: the delimiter and the encoding are detected', () => {
		const semicolons = csvOf(
			[
				['Employee', 'Date', 'hours'],
				['Zoë', '2026-01-02', '6']
			],
			';'
		);
		const latin1 = new Uint8Array([...text('Employee,Date\nJos'), 0xe9, ...text(',2026-01-05\n')]);
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...text('Employee,Date\r\nann,2026-01-01\r\n')]);
		expect(parse('csv', text(semicolons)).records).toEqual([
			{ person: 'Zoë', day: '2026-01-02', hours: 6, $at: 2 }
		]);
		expect(parse('csv', latin1).records).toEqual([{ person: 'José', day: '2026-01-05', $at: 2 }]);
		expect(parse('csv', bom).records).toEqual([{ person: 'ann', day: '2026-01-01', $at: 2 }]);
	});

	it('tsv: tabs, a comma kept in its cell', () => {
		expect(parse('tsv', text('Employee\tDate\nann, jr\t2026-01-01\n')).records).toEqual([
			{ person: 'ann, jr', day: '2026-01-01', $at: 2 }
		]);
	});

	it('json: an array of records or { records }, keys by name or label; a non-record is refused at its place', () => {
		expect(
			parse('json', text(JSON.stringify([{ Employee: 'ann', day: '2026-01-01', x: 1 }])))
		).toEqual({
			records: [{ person: 'ann', day: '2026-01-01', $at: 1 }],
			findings: []
		});
		expect(parse('json', text(JSON.stringify({ records: [{ person: 'bob' }, 3] })))).toEqual({
			records: [{ person: 'bob', $at: 1 }],
			findings: [{ at: 2, message: 'This is not a record.', severity: 'refuse' }]
		});
		expect(parse('json', text('{"rows": []}')).findings).toEqual([
			{ at: 0, message: expect.stringContaining('list of records'), severity: 'refuse' }
		]);
	});

	it('ics: each VEVENT is a record at its BEGIN line; folded lines, all-day dates, UTC, TZID and floating times; alarms skipped', () => {
		const ics = [
			'BEGIN:VCALENDAR',
			'BEGIN:VEVENT',
			'UID:1',
			'SUMMARY:Stand-up\\, daily',
			' and long',
			'DTSTART;VALUE=DATE:20260105',
			'BEGIN:VALARM',
			'SUMMARY:alarm',
			'END:VALARM',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:2',
			'DTSTART;TZID=Asia/Singapore:20260106T090000',
			'DTEND:20260106T020000Z',
			'END:VEVENT',
			'BEGIN:VEVENT',
			'UID:3',
			'DTSTART:20260107T090000',
			'END:VEVENT',
			'END:VCALENDAR'
		].join('\r\n');
		const cal: InputFields = {
			uid: { kind: 'text' },
			summary: { kind: 'text', optional: true },
			dtstart: { kind: 'text' },
			dtend: { kind: 'instant', optional: true }
		};
		expect(parseBuiltin('ics', text(ics), cal, { required: [], tz: 'Europe/London' })).toEqual({
			records: [
				{ uid: '1', summary: 'Stand-up, dailyand long', dtstart: '2026-01-05', $at: 2 },
				{
					uid: '2',
					dtstart: '2026-01-06T01:00:00.000Z',
					dtend: '2026-01-06T02:00:00.000Z',
					$at: 11
				},
				{ uid: '3', dtstart: '2026-01-07T09:00:00.000Z', $at: 16 }
			],
			findings: []
		});
	});

	it('a file that is no such format is one refusal at 0, the file as a whole', () => {
		expect(parse('xlsx', text('not a zip'))).toEqual({
			records: [],
			findings: [
				{ at: 0, message: expect.stringContaining('not a readable xlsx file'), severity: 'refuse' }
			]
		});
		expect(parse('json', text('{')).findings).toEqual([
			{ at: 0, message: 'The file is not JSON.', severity: 'refuse' }
		]);
	});
});

describe('which parser an upload is read with', () => {
	const parsers: readonly Parser[] = [
		'xlsx',
		'csv',
		{ type: 'application/vnd.ms-excel', extensions: ['.ofx'] }
	];
	it('by extension first (a browser may send a wrong type), then by media type; nothing else', () => {
		expect(parserFor(parsers, 'Roster.CSV', 'application/vnd.ms-excel')).toBe('csv');
		expect(parserFor(parsers, 'bank.ofx', '')).toEqual(parsers[2]);
		expect(parserFor(parsers, 'upload', 'text/csv; charset=utf-8')).toBe('csv');
		expect(parserFor(parsers, 'events.ics', 'text/calendar')).toBeUndefined();
	});
	it("a sync's accept list is its parsers' extensions and types; no parser list is xlsx and csv", () => {
		expect(acceptOf(parsers)).toBe(
			'.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv,.ofx,application/vnd.ms-excel'
		);
		expect(parsersOf({})).toEqual(['xlsx', 'csv']);
	});
});
