/**
 * One person-day, assembled from every source that has an opinion about it.
 *
 * A roster says what was *planned*; a time entry says whether the person *appeared*; leave and the
 * holiday calendar say why an empty day is empty. Shown separately these are four screens nobody
 * cross-references, which is how a rostered shift with no attendance stays invisible until payroll.
 * Merged into one cell they answer the question an operator actually has: is this day settled, and
 * if not, what is wrong with it.
 *
 * A public holiday is NOT one of those answers. It is a property of the calendar rather than of one
 * person's roster — `roster_entries` has no holiday arm for the same reason — so it is carried here
 * as an overlay on the date and drawn as a column of the board, leaving each cell free to keep
 * saying what that person's day is. A holiday that replaced the cell would hide whether the person
 * was rostered to work it and whether they turned up, which is precisely what an operator needs to
 * know about a holiday.
 *
 * Display only. Nothing here prices anything — the payroll engine resolves day types itself from the
 * same rows, and `docs/architecture/time-overtime-and-cutoffs.md` is the authority on how.
 */

import { calendarDayKey, daysInMonth } from '../calendar.js';
import type { I18nApi } from '@norbital-ai/ui/i18n';
import type { TenantI18nKeys } from '$pod/i18n-keys';

/** The translation callback a display helper takes, so it stays locale-reactive at the call site. */
export type Translator = I18nApi<TenantI18nKeys>['t'];

export type Designation = 'WORK' | 'REST' | 'OFF';

/** Why a planned working day has no attendance behind it, in the order an operator cares about. */
export type DayStatus =
	'UNROSTERED' | 'PLANNED' | 'ATTENDED' | 'OPEN' | 'ABSENT' | 'ON_LEAVE' | 'REST' | 'OFF';

export type DayFacts = {
	readonly employmentId: string;
	readonly date: string;
	/** `null` when no roster entry covers the day at all. */
	readonly designation: Designation | null;
	/** The shift the day is worked on. Null on a rest or off day, which schedules none. */
	readonly shiftCode: string | null;
	/** The source roster token, e.g. `AMRES` or `OFF/S`, when the roster carried one. */
	readonly assignmentCode: string | null;
	/** Overlaid from `company_holidays`, never stored on the entry. */
	readonly holidayName: string | null;
	readonly leaveCode: string | null;
	readonly halfDayLeave: boolean;
	readonly clockedIn: boolean;
	readonly attendanceState: 'OPEN' | 'CLOSED' | null;
	/** Whether the day falls inside the attendance window the next payroll run will settle. */
	readonly withinCutoff: boolean;
	readonly status: DayStatus;
};

export type RosterEntryLike = {
	readonly employment_id: string;
	readonly work_date: string | Date;
	readonly designation: string | null;
	readonly shift_definition_id: string | null;
	readonly assignment_code: string | null;
};

export type TimeEntryLike = {
	readonly employment_id: string;
	readonly work_date: string | Date;
	readonly clock_in: string | Date | null;
	readonly state: string | null;
};

export type LeaveRequestLike = {
	readonly employment_id: string;
	readonly kind: string | null;
	readonly leave_type_id: string;
	readonly from_date: string | Date | null;
	readonly to_date: string | Date | null;
	readonly half_day_start: boolean | null;
	readonly half_day_end: boolean | null;
};

export type HolidayLike = {
	readonly date: string | Date;
	readonly name: string;
};

/** Every calendar day of a `YYYY-MM` month, in order. */
export function monthDays(month: string): string[] {
	const count = daysInMonth(month);
	return Array.from(
		{ length: count },
		(_value, index) => `${month}-${String(index + 1).padStart(2, '0')}`
	);
}

/**
 * The company calendar as a date lookup.
 *
 * The board draws its holiday column from this and `buildRosterMonth` overlays the same map onto
 * every person-day, so a holiday cannot be marked in the header and missing from the cells below it.
 */
export function holidayNamesByDate(holidays: readonly HolidayLike[]): Map<string, string> {
	return new Map(holidays.map((holiday) => [calendarDayKey(holiday.date), holiday.name]));
}

function designationOf(value: string | null): Designation | null {
	return value === 'WORK' || value === 'REST' || value === 'OFF' ? value : null;
}

/**
 * Decide what one cell says, most specific reason first.
 *
 * Approved leave outranks an absence for the obvious reason: the person is not missing, they are on
 * leave, and calling that an absence is how a payroll ends up docking somebody who filed properly.
 *
 * A public holiday is not in this ladder at all — it is an overlay, not a status — but it does stop
 * a day being called an absence: nobody is expected to appear on a gazetted holiday, so a rostered
 * working day with no punches on one has not gone wrong.
 */
function statusOf(facts: Omit<DayFacts, 'status'>): DayStatus {
	if (facts.leaveCode != null) return 'ON_LEAVE';
	if (facts.designation === 'REST') return 'REST';
	if (facts.designation === 'OFF') return 'OFF';
	if (facts.designation == null) return 'UNROSTERED';
	if (facts.attendanceState === 'OPEN') return 'OPEN';
	if (facts.clockedIn) return 'ATTENDED';
	// A planned working day still in the future has simply not happened yet; one already inside the
	// window the next run will settle, with nothing clocked, is an absence somebody must explain.
	return facts.withinCutoff && facts.holidayName == null ? 'ABSENT' : 'PLANNED';
}

/**
 * Build the fact table for one month.
 *
 * `leaveRequests` are expanded across their whole range here rather than in the query, because a
 * request is stored once at its `from_date` and a calendar needs every day it covers.
 */
export function buildRosterMonth(options: {
	readonly month: string;
	readonly employmentIds: readonly string[];
	readonly rosterEntries: readonly RosterEntryLike[];
	readonly timeEntries: readonly TimeEntryLike[];
	readonly leaveRequests: readonly LeaveRequestLike[];
	readonly holidays: readonly HolidayLike[];
	readonly shiftCodeById: ReadonlyMap<string, string>;
	readonly leaveCodeById: ReadonlyMap<string, string>;
	readonly cutoff: { readonly start: string; readonly end: string } | null;
}): Map<string, DayFacts> {
	const days = monthDays(options.month);
	const first = days[0]!;
	const last = days[days.length - 1]!;

	const holidayByDate = holidayNamesByDate(options.holidays);

	const rosterByKey = new Map<string, RosterEntryLike>();
	for (const entry of options.rosterEntries) {
		rosterByKey.set(`${entry.employment_id}:${calendarDayKey(entry.work_date)}`, entry);
	}

	const timeByKey = new Map<string, TimeEntryLike>();
	for (const entry of options.timeEntries) {
		timeByKey.set(`${entry.employment_id}:${calendarDayKey(entry.work_date)}`, entry);
	}

	const leaveByKey = new Map<string, { code: string; halfDay: boolean }>();
	for (const request of options.leaveRequests) {
		if (request.kind !== 'TIME_OFF' || request.from_date == null || request.to_date == null)
			continue;
		const from = calendarDayKey(request.from_date);
		const to = calendarDayKey(request.to_date);
		if (to < first || from > last) continue;
		const code = options.leaveCodeById.get(request.leave_type_id) ?? 'LEAVE';
		for (const date of days) {
			if (date < from || date > to) continue;
			const halfDay =
				(date === from && request.half_day_start === true) ||
				(date === to && request.half_day_end === true);
			leaveByKey.set(`${request.employment_id}:${date}`, { code, halfDay });
		}
	}

	const facts = new Map<string, DayFacts>();
	for (const employmentId of options.employmentIds) {
		for (const date of days) {
			const key = `${employmentId}:${date}`;
			const roster = rosterByKey.get(key);
			const time = timeByKey.get(key);
			const leave = leaveByKey.get(key);
			const shiftId = roster?.shift_definition_id;
			const partial: Omit<DayFacts, 'status'> = {
				employmentId,
				date,
				designation: designationOf(roster?.designation ?? null),
				shiftCode: shiftId == null ? null : (options.shiftCodeById.get(shiftId) ?? null),
				assignmentCode: roster?.assignment_code ?? null,
				holidayName: holidayByDate.get(date) ?? null,
				leaveCode: leave?.code ?? null,
				halfDayLeave: leave?.halfDay ?? false,
				clockedIn: time?.clock_in != null,
				attendanceState: time?.state === 'OPEN' || time?.state === 'CLOSED' ? time.state : null,
				withinCutoff:
					options.cutoff != null && date >= options.cutoff.start && date <= options.cutoff.end
			};
			facts.set(key, { ...partial, status: statusOf(partial) });
		}
	}
	return facts;
}

/**
 * How each status reads, and how loudly.
 *
 * The board's cells, its legend and the scheduling app's filter all read this one table, so a day
 * cannot be described one way in a cell and another way in the control that selects it. Classes are
 * literal variants, never assembled, so Tailwind can see every one of them. The label is a catalog
 * key so every surface resolves it through the same `t`; a locale switch re-reads it everywhere at
 * once.
 */
export const STATUS_PRESENTATION: Record<
	DayStatus,
	{ readonly labelKey: TenantI18nKeys; readonly className: string }
> = {
	UNROSTERED: { labelKey: 'roster.unrostered', className: 'bg-muted/30 text-muted-foreground' },
	PLANNED: {
		labelKey: 'roster.planned',
		className: 'bg-brand-50 text-brand-700 dark:bg-brand-950 dark:text-brand-200'
	},
	ATTENDED: { labelKey: 'roster.attended', className: 'bg-success/15 text-success-foreground' },
	OPEN: { labelKey: 'roster.open_punch', className: 'bg-warning/25 text-warning-foreground' },
	ABSENT: {
		labelKey: 'roster.absent',
		className: 'bg-destructive/20 font-semibold text-destructive'
	},
	ON_LEAVE: { labelKey: 'roster.leave', className: 'bg-accent text-accent-foreground' },
	REST: { labelKey: 'roster.rest_day', className: 'bg-muted text-muted-foreground' },
	OFF: { labelKey: 'roster.off_day', className: 'bg-muted/60 text-muted-foreground' }
};

/**
 * The holiday overlay, which sits on the date rather than on the person.
 *
 * It is a separate constant from `STATUS_PRESENTATION` because it is a separate axis: a cell can be
 * `ATTENDED` and on a public holiday at once, and a board that had to choose between saying those
 * two things would always be hiding one of them.
 */
export const HOLIDAY_PRESENTATION = {
	mark: 'PH',
	labelKey: 'roster.public_holiday' as TenantI18nKeys,
	/** Body cells: translucent, so the status chip sitting inside the cell stays legible through it. */
	className: 'bg-brand/20',
	/**
	 * The day header, which is `position: sticky` and therefore must be OPAQUE. A translucent sticky
	 * cell is not a lighter shade of the header — it is a window, and the rows scrolling underneath
	 * are visible straight through it.
	 */
	headerClassName: 'bg-brand-100 text-brand-700 dark:bg-brand-900 dark:text-brand-100'
} as const;

/** The glyph a cell carries: the shift code when there is one, else what kind of day it is. */
export function statusGlyph(day: DayFacts): string {
	switch (day.status) {
		case 'ON_LEAVE':
			return day.halfDayLeave ? '½' : 'L';
		case 'REST':
			return 'R';
		case 'OFF':
			return 'O';
		case 'UNROSTERED':
			return '·';
		case 'ABSENT':
			return '!';
		case 'OPEN':
			return '⧗';
		case 'ATTENDED':
		case 'PLANNED':
			return day.shiftCode ?? 'W';
		default: {
			const unhandled: never = day.status;
			throw new Error(`Unhandled day status: ${String(unhandled)}`);
		}
	}
}

/** One line describing everything known about a day, for a cell's hover text. */
export function describeDay(day: DayFacts | undefined, heading: string, t: Translator): string {
	if (day == null) return heading;
	return [
		heading,
		t(STATUS_PRESENTATION[day.status].labelKey),
		day.shiftCode == null ? null : t('roster.shift_code', { code: day.shiftCode }),
		day.assignmentCode == null ? null : t('roster.assignment_code', { code: day.assignmentCode }),
		day.holidayName == null ? null : `${t(HOLIDAY_PRESENTATION.labelKey)}: ${day.holidayName}`,
		day.leaveCode == null
			? null
			: `${day.leaveCode}${day.halfDayLeave ? ` (${t('roster.half_day')})` : ''}`,
		day.withinCutoff ? t('roster.inside_cutoff') : null
	]
		.filter((part) => part != null && part !== '')
		.join(' — ');
}

/** A tally of the month by status, for the board's summary strip. */
export function summarizeRosterMonth(facts: ReadonlyMap<string, DayFacts>): Map<DayStatus, number> {
	const counts = new Map<DayStatus, number>();
	for (const day of facts.values()) {
		counts.set(day.status, (counts.get(day.status) ?? 0) + 1);
	}
	return counts;
}

/**
 * How far the month has got: not drafted, being drafted, or published.
 *
 * This is the difference between an empty month and a broken one, and the board has to draw it
 * because the two look identical in the tally. A month nobody has opened yet has every person-day
 * unrostered — three hundred people times thirty-one days is nine thousand of them — and reporting
 * that as an exception in alarm red says a catastrophe has happened where in fact nothing has
 * happened at all. An unrostered day only becomes a fault once the month has been published, which
 * is the point at which the roster claims to be complete.
 */
export type MonthDrafting = 'NOT_DRAFTED' | 'DRAFT' | 'PUBLISHED';

export type MonthProgress = {
	readonly drafting: MonthDrafting;
	/** People times days: the size of the month, and the denominator of everything below. */
	readonly personDays: number;
	readonly rostered: number;
	readonly unrostered: number;
	/**
	 * The things somebody has to act on now. Attendance faults always count; an unrostered day
	 * counts only in a published month, where it is a hole rather than unfinished work.
	 */
	readonly exceptions: readonly { readonly status: DayStatus; readonly count: number }[];
};

/** Statuses that mean a person-day needs somebody, once the month is far enough along to say so. */
const ATTENDANCE_EXCEPTIONS: readonly DayStatus[] = ['ABSENT', 'OPEN'];

export function monthProgress(
	facts: ReadonlyMap<string, DayFacts>,
	drafting: MonthDrafting
): MonthProgress {
	const counts = summarizeRosterMonth(facts);
	const personDays = facts.size;
	const unrostered = counts.get('UNROSTERED') ?? 0;
	const statuses: DayStatus[] =
		drafting === 'PUBLISHED'
			? [...ATTENDANCE_EXCEPTIONS, 'UNROSTERED']
			: [...ATTENDANCE_EXCEPTIONS];
	return {
		drafting,
		personDays,
		rostered: personDays - unrostered,
		unrostered,
		exceptions: statuses
			.map((status) => ({ status, count: counts.get(status) ?? 0 }))
			.filter((entry) => entry.count > 0)
	};
}
