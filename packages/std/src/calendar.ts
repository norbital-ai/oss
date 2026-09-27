// std/calendar (§3.7, §5.4): pay and billing cycles (a cycle is named by the day it OPENS), working days and
// business-hour deadlines (SLAs) over a work week and holiday rows.
import { addDays, addMonths, PlainDate, type DatePeriod, type Instant } from './date.ts';
import { Decimal } from './decimal.ts';
import { DAY_MS, localOf, utcOf } from './zone.ts';

/**
 * A pay or billing cycle, named by the day it opens: monthly (`opensOn` 1–28), semi-monthly, weekly (ISO weekday) or every `n`
 * days from an anchor date.
 */
export type Cycle =
	| { readonly every: 'month'; readonly opensOn?: number }          // 1–28; default 1
	| { readonly every: 'semiMonth'; readonly secondOpensOn?: number } // 2–28; default 16
	| { readonly every: 'week'; readonly opensOn: 1 | 2 | 3 | 4 | 5 | 6 | 7 } // ISO weekday, 1 = Monday
	| { readonly every: 'days'; readonly n: number; readonly anchor: PlainDate | string };

type Hours = { readonly start: string; readonly end: string } | null;  // 'HH:MM' wall times in the calendar's zone
export type WorkCalendar = {
	readonly zone: string;
	readonly week: { readonly [D in 1 | 2 | 3 | 4 | 5 | 6 | 7]: Hours };
	readonly holidays: ReadonlySet<string>;
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (t: string) => { const m = TIME.exec(t); if (m === null) throw new RangeError(`'${t}' is not HH:MM`); return Number(m[1]) * 60 + Number(m[2]); };
const weekday = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 as 1 | 2 | 3 | 4 | 5 | 6 | 7;
const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;

/** A checked work calendar: every day's hours are `start < end`, holidays are calendar dates. */
export function WorkCalendar(c: { zone: string; week: WorkCalendar['week']; holidays?: Iterable<string> }): WorkCalendar {
	new Intl.DateTimeFormat('en-US', { timeZone: c.zone });
	for (const h of Object.values(c.week)) if (h !== null && minutes(h.start) >= minutes(h.end)) throw new RangeError(`hours ${h.start}–${h.end} end before they start`);
	return { zone: c.zone, week: c.week, holidays: new Set([...(c.holidays ?? [])].map((d) => PlainDate(d))) };
}

/** The cycle that holds `day`. */
export function cycleOf(rule: Cycle, day: PlainDate | string): DatePeriod {
	const d = PlainDate(day);
	switch (rule.every) {
		case 'month': {
			const opens = rule.opensOn ?? 1;
			if (!Number.isInteger(opens) || opens < 1 || opens > 28) throw new RangeError('opensOn is a day 1–28');
			const here = PlainDate(`${d.slice(0, 8)}${String(opens).padStart(2, '0')}`);
			const from = here <= d ? here : addMonths(here, -1);
			return { from, to: addDays(addMonths(from, 1), -1) };
		}
		case 'semiMonth': {
			const second = rule.secondOpensOn ?? 16;
			if (!Number.isInteger(second) || second < 2 || second > 28) throw new RangeError('secondOpensOn is a day 2–28');
			const mid = PlainDate(`${d.slice(0, 8)}${String(second).padStart(2, '0')}`), first = PlainDate(`${d.slice(0, 8)}01`);
			return d < mid ? { from: first, to: addDays(mid, -1) } : { from: mid, to: addDays(addMonths(first, 1), -1) };
		}
		case 'week': {
			const from = addDays(d, -((weekday(d) - rule.opensOn + 7) % 7));
			return { from, to: addDays(from, 6) };
		}
		case 'days': {
			if (!Number.isInteger(rule.n) || rule.n < 1) throw new RangeError('n is a whole number of days ≥ 1');
			const anchor = PlainDate(rule.anchor);
			const from = addDays(anchor, Math.floor((dayNumber(d) - dayNumber(anchor)) / rule.n) * rule.n);
			return { from, to: addDays(from, rule.n - 1) };
		}
	}
}

/** Every cycle that shares a day with `within` (a closed period), in order. */
export function cycles(rule: Cycle, within: DatePeriod): DatePeriod[] {
	if (within.to === null) throw new RangeError('cycles needs a closed period');
	const out: DatePeriod[] = [];
	for (let c = cycleOf(rule, within.from); c.from <= within.to; c = cycleOf(rule, addDays(c.to!, 1))) out.push(c);
	return out;
}

const worked = (cal: WorkCalendar, d: string) => cal.week[weekday(d)] !== null && !cal.holidays.has(d);

/** Working days in a closed period: a weekday with hours that is not a holiday. */
export function businessDays(p: DatePeriod, cal: WorkCalendar): number {
	if (p.to === null) throw new RangeError('businessDays needs a closed period');
	let n = 0;
	for (let d: string = p.from; d <= p.to; d = addDays(d, 1)) if (worked(cal, d)) n++;
	return n;
}

/**
 * The instant `hours` working hours after `from`, counting only each working day's hours in the calendar's zone
 * (an SLA due time). Zero hours from outside hours is the next opening.
 */
export function addBusinessHours(from: Instant | string, hours: Decimal | number, cal: WorkCalendar): Instant {
	let left = (hours instanceof Decimal ? hours : Decimal.fromNumber(hours, 6)).times(3_600_000).round(0).toNumber();
	if (left < 0) throw new RangeError('hours must be ≥ 0');
	let { date, msOfDay } = localOf(Date.parse(from), cal.zone);
	for (let i = 0; i < 3_660; i++, date = addDays(date, 1), msOfDay = 0) {
		const h = cal.week[weekday(date)];
		if (h === null || cal.holidays.has(date)) continue;
		const start = Math.max(minutes(h.start) * 60_000, msOfDay), end = minutes(h.end) * 60_000;
		if (start >= end) continue;
		if (left <= end - start) return new Date(utcOf(date, start + left, cal.zone)).toISOString() as Instant;
		left -= end - start;
	}
	throw new RangeError('the calendar has no working hours within ten years');
}
