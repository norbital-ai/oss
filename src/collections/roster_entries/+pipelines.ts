import { isCalendarDate } from '@norbital-ai/std/date';
import { z } from 'zod';
import type { Pipelines } from './$types.js';

const rowSchema = z.object({
	employee_number: z.string().trim().min(1),
	work_date: z.string().trim().min(1),
	day_type: z.enum(['WORK', 'REST', 'OFF', 'PUBLIC_HOLIDAY']),
	/** Required on every row: even REST/OFF days keep the employee's underlying working shift attached. */
	shift_code: z.string().trim().min(1),
	assignment_code: z.string().trim().min(1).optional(),
	note: z.string().optional()
});

const importSchema = z.object({
	roster_id: z.string().trim().min(1),
	rows: z.array(rowSchema).min(1)
});

const QUERY_LIMIT = 20_000;
const NAMED_LIMIT = 20;

type ImportRow = z.infer<typeof rowSchema>;
type Designation = 'WORK' | 'REST' | 'OFF';

function formatNamedList(items: readonly string[], limit = NAMED_LIMIT): string {
	const shown = items.slice(0, limit);
	const lines = shown.map((item) => `• ${item}`);
	const remainder = items.length > limit ? `\n…and ${items.length - limit} more.` : '';
	return `${lines.join('\n')}${remainder}`;
}

function monthBounds(month: string): { readonly start: string; readonly end: string } {
	const [year, index] = month.split('-').map(Number) as [number, number];
	const start = `${month}-01`;
	const lastDay = new Date(Date.UTC(year, index, 0)).getUTCDate();
	return { start, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function dateInMonth(workDate: string, month: string): boolean {
	const bounds = monthBounds(month);
	return workDate >= bounds.start && workDate <= bounds.end;
}

function dateKey(value: string | Date): string {
	return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/**
 * Import drafted roster assignments into `roster_entries`.
 *
 * Rows land on one draft roster month so publication can validate them before payroll reads the
 * schedule. The platform writes every returned payload in one transaction.
 */
export default {
	import: {
		input: importSchema,
		handler: async ({ input }, api) => {
			// Re-parsed rather than cast: the pipeline type erases the schema's output type, and a
			// cast would assert a shape the payload has not been shown to have.
			const { roster_id: rosterId, rows } = importSchema.parse(input);

			const roster = await api.db.query.rosters.findFirst({
				where: { norbital_id: { eq: rosterId } },
				columns: { month: true, published_at: true, company_id: true }
			});
			if (roster == null) {
				throw new Error(
					'That roster does not exist. Create the draft month first, then import its assignments ' +
						'into it.'
				);
			}
			if (roster.published_at != null) {
				throw new Error(
					`Roster ${roster.month} is published, so its entries are fixed. Re-open the month to import ` +
						'into it — that way the change is deliberate and the month is re-validated when it is ' +
						'published again.'
				);
			}

			const invalidDates = [
				...new Set(rows.filter((row) => !isCalendarDate(row.work_date)).map((row) => row.work_date))
			];
			if (invalidDates.length > 0) {
				throw new Error(
					`These work_date values are not valid calendar days (YYYY-MM-DD):\n${formatNamedList(invalidDates)}`
				);
			}

			const outsideMonth = [
				...new Set(
					rows
						.filter((row) => !dateInMonth(row.work_date, roster.month))
						.map((row) => `${row.employee_number} on ${row.work_date}`)
				)
			];
			if (outsideMonth.length > 0) {
				throw new Error(
					`Roster ${roster.month} owns only its own calendar days. These rows fall outside it:\n${formatNamedList(outsideMonth)}\n` +
						'Move them to the roster for that month instead.'
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
				where: {
					company_id: { eq: roster.company_id },
					employee_number: { in: employeeNumbers }
				},
				columns: { norbital_id: true, employee_number: true },
				limit: QUERY_LIMIT
			});
			const employmentIdByNumber = new Map(
				employments.map((employment) => [employment.employee_number, employment.norbital_id])
			);
			const unknownEmployees = employeeNumbers.filter(
				(number) => !employmentIdByNumber.has(number)
			);
			if (unknownEmployees.length > 0) {
				throw new Error(
					`These employee numbers are not employed by this company:\n${formatNamedList(unknownEmployees)}\n` +
						'Create the employment first, or fix the number in the source file.'
				);
			}

			const shiftCodes = [...new Set(rows.map((row) => row.shift_code))];
			const shifts = await api.db.query.shift_definitions.findMany({
				where: {
					company_id: { eq: roster.company_id },
					code: { in: shiftCodes }
				},
				columns: { norbital_id: true, code: true },
				limit: QUERY_LIMIT
			});
			const shiftIdByCode = new Map(shifts.map((shift) => [shift.code, shift.norbital_id]));
			const unknownShifts = shiftCodes.filter((code) => !shiftIdByCode.has(code));
			if (unknownShifts.length > 0) {
				throw new Error(
					`These shift codes are not defined for this company:\n${formatNamedList(unknownShifts)}\n` +
						'Create the shift definition first, or fix the code in the source file.'
				);
			}

			const holidayRows = rows.filter((row) => row.day_type === 'PUBLIC_HOLIDAY');
			if (holidayRows.length > 0) {
				const holidayDates = [...new Set(holidayRows.map((row) => row.work_date))];
				const configured = await api.db.query.company_holidays.findMany({
					where: {
						company_id: { eq: roster.company_id },
						date: { in: holidayDates }
					},
					columns: { date: true },
					limit: QUERY_LIMIT
				});
				const configuredDates = new Set(configured.map((holiday) => dateKey(holiday.date)));
				const unconfigured = [
					...new Set(
						holidayRows
							.filter((row) => !configuredDates.has(row.work_date))
							.map((row) => `${row.employee_number} on ${row.work_date}`)
					)
				];
				if (unconfigured.length > 0) {
					throw new Error(
						'These rows claim a public holiday, but that date is not on the company calendar:\n' +
							`${formatNamedList(unconfigured)}\n` +
							'Add the holiday to company_holidays first. Public holidays are overlaid from the ' +
							'calendar at calculation time — a roster row without a matching holiday would price as ' +
							'an ordinary off day.'
					);
				}
			}

			/*
			 * Unknown employee numbers and shift codes were refused above, so these always resolve.
			 * They are assertions rather than casts so that an edit which moves those checks cannot
			 * quietly write a row pointing at no employment or no shift.
			 */
			const employmentIdFor = (employeeNumber: string): string => {
				const id = employmentIdByNumber.get(employeeNumber);
				if (id == null) throw new Error(`No employment resolved for ${employeeNumber}.`);
				return id;
			};
			const shiftIdFor = (shiftCode: string): string => {
				const id = shiftIdByCode.get(shiftCode);
				if (id == null) throw new Error(`No shift resolved for ${shiftCode}.`);
				return id;
			};

			const employmentIds = [...new Set(rows.map((row) => employmentIdFor(row.employee_number)))];
			const workDates = [...new Set(rows.map((row) => row.work_date))];
			const existing = await api.db.query.roster_entries.findMany({
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
					'These days already have a roster entry:\n' +
						`${formatNamedList(alreadyPresent)}\n` +
						'Delete or update the existing row instead of importing a duplicate.'
				);
			}

			return rows.map((row) => ({
				employment_id: employmentIdFor(row.employee_number),
				work_date: row.work_date,
				shift_definition_id: shiftIdFor(row.shift_code),
				roster_id: rosterId,
				assignment_code: row.assignment_code ?? null,
				designation: designationFor(row)
			}));
		}
	}
} satisfies Pipelines;

/**
 * A public holiday is stored as an off day.
 *
 * `designation` has no holiday arm because a holiday is not a property of the roster: it is overlaid
 * from `company_holidays` at calculation time, so a gazetted holiday reaches payroll whether or not
 * a roster mentions it. Recording it as OFF states the roster's own fact — that no shift was
 * scheduled — while leaving the holiday itself to the calendar. The handler has already refused any
 * PUBLIC_HOLIDAY row whose date the calendar does not know, so the two cannot disagree.
 */
function designationFor(row: ImportRow): Designation {
	switch (row.day_type) {
		case 'WORK':
			return 'WORK';
		case 'REST':
			return 'REST';
		case 'OFF':
		case 'PUBLIC_HOLIDAY':
			return 'OFF';
		default: {
			const unhandled: never = row.day_type;
			throw new Error(`Unhandled day type: ${String(unhandled)}`);
		}
	}
}
