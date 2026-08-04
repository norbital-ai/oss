import { isCalendarDate, isClockTime, isUtcIsoInstant } from '@norbital-ai/std/date';
import { z } from 'zod';
import type { Pipelines } from './$types.js';

const rowSchema = z.object({
	employee_number: z.string().trim().min(1),
	work_date: z.string().trim().min(1),
	clock_in: z.string().trim().optional(),
	clock_out: z.string().trim().optional(),
	break_minutes: z.number().int().nonnegative().optional(),
	overtime_in: z.string().trim().optional(),
	overtime_out: z.string().trim().optional(),
	overtime_authorized: z.boolean().optional(),
	state: z.enum(['OPEN', 'CLOSED']).optional(),
	/** Informational provenance only — leave is recorded on leave_requests, not here. */
	reason: z.string().optional()
});

const importSchema = z.object({
	timezone: z.string().trim().min(1),
	rows: z.array(rowSchema).min(1)
});

const QUERY_LIMIT = 20_000;
const NAMED_LIMIT = 20;

type ImportRow = z.infer<typeof rowSchema>;

function formatNamedList(items: readonly string[], limit = NAMED_LIMIT): string {
	const shown = items.slice(0, limit);
	const lines = shown.map((item) => `• ${item}`);
	const remainder = items.length > limit ? `\n…and ${items.length - limit} more.` : '';
	return `${lines.join('\n')}${remainder}`;
}

function addDays(date: string, days: number): string {
	const parsed = Date.parse(`${date}T00:00:00.000Z`);
	return new Date(parsed + days * 86_400_000).toISOString().slice(0, 10);
}

function dateKey(value: string | Date): string {
	return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

function assertValidTimeZone(timeZone: string): void {
	try {
		Intl.DateTimeFormat(undefined, { timeZone });
	} catch {
		throw new Error(
			`"${timeZone}" is not a recognized IANA timezone. Use a name like Asia/Kuala_Lumpur that ` +
				'identifies the place, not a fixed UTC offset.'
		);
	}
}

function clockMinutes(value: string): number {
	const [hours, minutes] = value.split(':').map(Number) as [number, number];
	return hours * 60 + minutes;
}

/** When clock_out is at or before clock_in on the wall clock, the close belongs to the next calendar day. */
function punchCalendarDate(workDate: string, clockIn: string, clockOut: string): string {
	return clockMinutes(clockOut) <= clockMinutes(clockIn) ? addDays(workDate, 1) : workDate;
}

function localWallTimeToUtcIso(calendarDate: string, clockTime: string, timeZone: string): string {
	const [year, month, day] = calendarDate.split('-').map(Number) as [number, number, number];
	const [hour, minute] = clockTime.split(':').map(Number) as [number, number];

	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false
	});

	const readShownMs = (instant: Date): number => {
		const parts = formatter.formatToParts(instant);
		const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
			parts.find((part) => part.type === type)?.value ?? '';
		let shownHour = Number(valueFor('hour'));
		if (shownHour === 24) shownHour = 0;
		return Date.UTC(
			Number(valueFor('year')),
			Number(valueFor('month')) - 1,
			Number(valueFor('day')),
			shownHour,
			Number(valueFor('minute')),
			Number(valueFor('second'))
		);
	};

	const desiredMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
	let utcMs = desiredMs;

	for (let attempt = 0; attempt < 6; attempt++) {
		const delta = desiredMs - readShownMs(new Date(utcMs));
		if (delta === 0) break;
		utcMs += delta;
	}

	if (readShownMs(new Date(utcMs)) !== desiredMs) {
		throw new Error(
			`Could not resolve ${calendarDate} ${clockTime} in ${timeZone} to a UTC instant. The local ` +
				'time may fall in a daylight-saving gap — fix the source time or choose a valid instant.'
		);
	}

	const iso = new Date(utcMs).toISOString();
	if (!isUtcIsoInstant(iso)) {
		throw new Error(
			`Could not resolve ${calendarDate} ${clockTime} in ${timeZone} to a UTC instant. Check the ` +
				'date and time in the source file.'
		);
	}
	return iso;
}

function optionalLocalInstant(
	workDate: string,
	clockTime: string | undefined,
	timeZone: string
): string | null {
	if (clockTime == null) return null;
	if (!isClockTime(clockTime)) {
		throw new Error(
			`"${clockTime}" is not a valid local clock time (HH:mm). Fix the source file before importing.`
		);
	}
	return localWallTimeToUtcIso(workDate, clockTime, timeZone);
}

/**
 * Import clock punches into `time_entries`.
 *
 * Source files carry local wall-clock times; this pipeline resolves them to UTC instants using the
 * file's IANA timezone before the platform writes every row in one transaction.
 */
export default {
	import: {
		input: importSchema,
		handler: async ({ input }, api) => {
			// Re-parsed rather than cast: the pipeline type erases the schema's output type, and a
			// cast would assert a shape the payload has not been shown to have.
			const { timezone, rows } = importSchema.parse(input);
			assertValidTimeZone(timezone);

			const invalidDates = [
				...new Set(rows.filter((row) => !isCalendarDate(row.work_date)).map((row) => row.work_date))
			];
			if (invalidDates.length > 0) {
				throw new Error(
					`These work_date values are not valid calendar days (YYYY-MM-DD):\n${formatNamedList(invalidDates)}`
				);
			}

			const seenPairs = new Set<string>();
			const duplicatePairs: string[] = [];
			for (const row of rows) {
				const key = `${row.employee_number}\t${row.work_date}`;
				if (seenPairs.has(key)) duplicatePairs.push(`${row.employee_number} on ${row.work_date}`);
				seenPairs.add(key);
			}
			if (duplicatePairs.length > 0) {
				throw new Error(
					'The import repeats the same employee on the same day more than once:\n' +
						`${formatNamedList(duplicatePairs)}\n` +
						'Keep one row per person per date.'
				);
			}

			const employeeNumbers = [...new Set(rows.map((row) => row.employee_number))];
			const employments = await api.db.query.employments.findMany({
				where: { employee_number: { in: employeeNumbers } },
				columns: { norbital_id: true, employee_number: true, company_id: true },
				limit: QUERY_LIMIT
			});
			const employmentIdsByNumber = new Map<string, string[]>();
			for (const employment of employments) {
				const ids = employmentIdsByNumber.get(employment.employee_number) ?? [];
				ids.push(employment.norbital_id);
				employmentIdsByNumber.set(employment.employee_number, ids);
			}
			const ambiguous = employeeNumbers.filter(
				(number) => (employmentIdsByNumber.get(number)?.length ?? 0) > 1
			);
			if (ambiguous.length > 0) {
				throw new Error(
					`These employee numbers belong to more than one company and cannot be resolved ` +
						`without a company scope:\n${formatNamedList(ambiguous)}`
				);
			}
			const employmentIdByNumber = new Map(
				employments.map((employment) => [employment.employee_number, employment.norbital_id])
			);
			const unknownEmployees = employeeNumbers.filter(
				(number) => !employmentIdByNumber.has(number)
			);
			if (unknownEmployees.length > 0) {
				throw new Error(
					`These employee numbers are not on file:\n${formatNamedList(unknownEmployees)}\n` +
						'Create the employment first, or fix the number in the source file.'
				);
			}

			const invalidClockFields: string[] = [];
			const incompleteOt: string[] = [];
			const closedWithoutClocks: string[] = [];
			for (const row of rows) {
				const identity = `${row.employee_number} on ${row.work_date}`;
				for (const [label, value] of [
					['clock_in', row.clock_in],
					['clock_out', row.clock_out],
					['overtime_in', row.overtime_in],
					['overtime_out', row.overtime_out]
				] as const) {
					if (value != null && !isClockTime(value)) {
						invalidClockFields.push(`${identity}: ${label} "${value}"`);
					}
				}
				const hasOtIn = row.overtime_in != null;
				const hasOtOut = row.overtime_out != null;
				if (hasOtIn !== hasOtOut) {
					incompleteOt.push(identity);
				}
				const hasClockIn = row.clock_in != null;
				const hasClockOut = row.clock_out != null;
				const derivedState = hasClockIn && hasClockOut ? 'CLOSED' : 'OPEN';
				if (row.state === 'CLOSED' && derivedState !== 'CLOSED') {
					closedWithoutClocks.push(identity);
				}
			}
			if (invalidClockFields.length > 0) {
				throw new Error(
					`These clock fields are not valid local times (HH:mm):\n${formatNamedList(invalidClockFields)}`
				);
			}
			if (incompleteOt.length > 0) {
				throw new Error(
					'These rows give only one half of the overtime punch pair:\n' +
						`${formatNamedList(incompleteOt)}\n` +
						'Leave both overtime_in and overtime_out empty, or supply both — the create hook enforces the pair.'
				);
			}
			if (closedWithoutClocks.length > 0) {
				throw new Error(
					'These rows are marked CLOSED but are missing a clock stamp:\n' +
						`${formatNamedList(closedWithoutClocks)}\n` +
						'Leave the row OPEN until both clock_in and clock_out exist.'
				);
			}

			/*
			 * Unknown numbers were refused above, so this always resolves. It is an assertion rather
			 * than a cast so that an edit which moves that check cannot quietly write a row with no
			 * employment behind it.
			 */
			const employmentIdFor = (employeeNumber: string): string => {
				const id = employmentIdByNumber.get(employeeNumber);
				if (id == null) throw new Error(`No employment resolved for ${employeeNumber}.`);
				return id;
			};

			const employmentIds = [...new Set(rows.map((row) => employmentIdFor(row.employee_number)))];
			const workDates = [...new Set(rows.map((row) => row.work_date))];
			const existing = await api.db.query.time_entries.findMany({
				where: {
					employment_id: { in: employmentIds },
					work_date: { in: workDates }
				},
				columns: { employment_id: true, work_date: true },
				limit: QUERY_LIMIT
			});
			const existingKeys = new Set(
				existing.map((entry) => `${entry.employment_id}\t${dateKey(entry.work_date)}`)
			);
			const alreadyPresent: string[] = [];
			for (const row of rows) {
				const key = `${employmentIdFor(row.employee_number)}\t${row.work_date}`;
				if (existingKeys.has(key)) {
					alreadyPresent.push(`${row.employee_number} on ${row.work_date}`);
				}
			}
			if (alreadyPresent.length > 0) {
				throw new Error(
					'These days already have a time entry:\n' +
						`${formatNamedList(alreadyPresent)}\n` +
						'Delete or update the existing row instead of importing a duplicate.'
				);
			}

			return rows.map((row) =>
				toCreatePayload(row, timezone, employmentIdFor(row.employee_number))
			);
		}
	}
} satisfies Pipelines;

function toInstant(value: string | null): Date | null {
	return value == null ? null : new Date(value);
}

function toCreatePayload(row: ImportRow, timeZone: string, employmentId: string) {
	const state = row.state ?? (row.clock_in != null && row.clock_out != null ? 'CLOSED' : 'OPEN');

	const clockIn = optionalLocalInstant(row.work_date, row.clock_in, timeZone);
	const clockOutDate =
		row.clock_in != null && row.clock_out != null
			? punchCalendarDate(row.work_date, row.clock_in, row.clock_out)
			: row.work_date;
	const clockOut = optionalLocalInstant(clockOutDate, row.clock_out, timeZone);

	const overtimeIn = optionalLocalInstant(row.work_date, row.overtime_in, timeZone);
	const overtimeOutDate =
		row.overtime_in != null && row.overtime_out != null
			? punchCalendarDate(row.work_date, row.overtime_in, row.overtime_out)
			: row.work_date;
	const overtimeOut = optionalLocalInstant(overtimeOutDate, row.overtime_out, timeZone);

	return {
		employment_id: employmentId,
		work_date: row.work_date,
		clock_in: toInstant(clockIn),
		clock_out: toInstant(clockOut),
		break_minutes: row.break_minutes ?? 0,
		state,
		overtime_authorized: row.overtime_authorized ?? null,
		overtime_in: toInstant(overtimeIn),
		overtime_out: toInstant(overtimeOut)
		// approved_ot_* buckets are not populated here: day type at calculation time decides the rate,
		// and the buckets are a legacy source-supplied input when a population tracks them explicitly.
	};
}
