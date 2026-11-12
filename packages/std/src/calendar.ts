// std/calendar (§3.7, §5.4): pay and billing cycles (a cycle is named by the day it OPENS), working days and
// business-hour deadlines (SLAs) over a work week and holiday rows.
import { add_days, add_months, Instant, PlainDate, type DatePeriod } from './date.ts';
import { Decimal } from './decimal.ts';
import { DAY_MS, local_of, utc_of } from './zone.ts';
import { Schema } from 'effect';

/**
 * A pay or billing cycle, named by the day it opens: monthly (`opens_on` 1–28), semi-monthly, weekly (ISO weekday) or every `n`
 * days from an anchor date.
 */
export const Cycle = Schema.Union([
	Schema.Struct({ every: Schema.Literal('month'), opens_on: Schema.optionalKey(Schema.Number) }),
	Schema.Struct({ every: Schema.Literal('semi_month'), second_opens_on: Schema.optionalKey(Schema.Number) }),
	Schema.Struct({ every: Schema.Literal('week'), opens_on: Schema.Literals([1, 2, 3, 4, 5, 6, 7]) }),
	Schema.Struct({ every: Schema.Literal('days'), n: Schema.Number, anchor: Schema.String })
]);
export type Cycle = typeof Cycle.Type;
const decode_cycle = Schema.decodeUnknownSync(Cycle, { onExcessProperty: 'error' });

type Hours = { readonly start: string; readonly end: string } | null; // 'HH:MM' wall times in the calendar's zone
export type WorkCalendar = {
	readonly zone: string;
	readonly week: { readonly [D in 1 | 2 | 3 | 4 | 5 | 6 | 7]: Hours };
	readonly holidays: ReadonlySet<string>;
};

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutes = (t: string) => {
	const m = TIME.exec(t);
	if (m === null) throw new RangeError(`'${t}' is not HH:MM`);
	return Number(m[1]) * 60 + Number(m[2]);
};
const ISO_DAY = [7, 1, 2, 3, 4, 5, 6] as const;
const weekday = (d: string) => ISO_DAY[new Date(`${d}T00:00:00Z`).getUTCDay()] ?? 7;
const dayNumber = (d: string) => Date.parse(`${d}T00:00:00Z`) / DAY_MS;

/** A checked work calendar: every day's hours are `start < end`, holidays are calendar dates. */
export function WorkCalendar(c: {
	zone: string;
	week: WorkCalendar['week'];
	holidays?: Iterable<string>;
}): WorkCalendar {
	new Intl.DateTimeFormat('en-US', { timeZone: c.zone });
	for (const h of Object.values(c.week))
		if (h !== null && minutes(h.start) >= minutes(h.end))
			throw new RangeError(`hours ${h.start}–${h.end} end before they start`);
	return {
		zone: c.zone,
		week: c.week,
		holidays: new Set([...(c.holidays ?? [])].map((d) => PlainDate(d)))
	};
}

/** The cycle that holds `day`. */
export function cycle_of(rule: Cycle, day: PlainDate | string): DatePeriod & { to: PlainDate } {
	const cycle = decode_cycle(rule),
		d = PlainDate(day);
	switch (cycle.every) {
		case 'month': {
			const opens = cycle.opens_on ?? 1;
			if (!Number.isInteger(opens) || opens < 1 || opens > 28)
				throw new RangeError('opens_on is a day 1–28');
			const here = PlainDate(`${d.slice(0, 8)}${String(opens).padStart(2, '0')}`);
			const from = here <= d ? here : add_months(here, -1);
			return { from, to: add_days(add_months(from, 1), -1) };
		}
		case 'semi_month': {
			const second = cycle.second_opens_on ?? 16;
			if (!Number.isInteger(second) || second < 2 || second > 28)
				throw new RangeError('second_opens_on is a day 2–28');
			const mid = PlainDate(`${d.slice(0, 8)}${String(second).padStart(2, '0')}`),
				first = PlainDate(`${d.slice(0, 8)}01`);
			return d < mid
				? { from: first, to: add_days(mid, -1) }
				: { from: mid, to: add_days(add_months(first, 1), -1) };
		}
		case 'week': {
			const from = add_days(d, -((weekday(d) - cycle.opens_on + 7) % 7));
			return { from, to: add_days(from, 6) };
		}
		case 'days': {
			if (!Number.isInteger(cycle.n) || cycle.n < 1)
				throw new RangeError('n is a whole number of days ≥ 1');
			const anchor = PlainDate(cycle.anchor);
			const from = add_days(
				anchor,
				Math.floor((dayNumber(d) - dayNumber(anchor)) / cycle.n) * cycle.n
			);
			return { from, to: add_days(from, cycle.n - 1) };
		}
	}
}

/** Every cycle that shares a day with `within` (a closed period), in order. */
export function cycles(rule: Cycle, within: DatePeriod): DatePeriod[] {
	if (within.to === null) throw new RangeError('cycles needs a closed period');
	const out: DatePeriod[] = [];
	for (
		let c = cycle_of(rule, within.from);
		c.from <= within.to;
		c = cycle_of(rule, add_days(c.to, 1))
	)
		out.push(c);
	return out;
}

const worked = (cal: WorkCalendar, d: string) =>
	cal.week[weekday(d)] !== null && !cal.holidays.has(d);

/** Working days in a closed period: a weekday with hours that is not a holiday. */
export function business_days(p: DatePeriod, cal: WorkCalendar): number {
	if (p.to === null) throw new RangeError('business_days needs a closed period');
	let n = 0;
	for (let d: string = p.from; d <= p.to; d = add_days(d, 1)) if (worked(cal, d)) n++;
	return n;
}

/**
 * The instant `hours` working hours after `from`, counting only each working day's hours in the calendar's zone
 * (an SLA due time). Zero hours from outside hours is the next opening.
 */
export function add_business_hours(
	from: Instant | string,
	hours: Decimal | number,
	cal: WorkCalendar
): Instant {
	let left = (hours instanceof Decimal ? hours : Decimal.from_number(hours, 6))
		.times(3_600_000)
		.round(0)
		.to_number();
	if (left < 0) throw new RangeError('hours must be ≥ 0');
	let { date, ms_of_day } = local_of(Date.parse(from), cal.zone);
	for (let i = 0; i < 3_660; i++, date = add_days(date, 1), ms_of_day = 0) {
		const h = cal.week[weekday(date)];
		if (h === null || cal.holidays.has(date)) continue;
		const start = Math.max(minutes(h.start) * 60_000, ms_of_day),
			end = minutes(h.end) * 60_000;
		if (start >= end) continue;
		if (left <= end - start)
			return Instant(new Date(utc_of(date, start + left, cal.zone)));
		left -= end - start;
	}
	throw new RangeError('the calendar has no working hours within ten years');
}
