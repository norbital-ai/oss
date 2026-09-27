// The event calendar's date arithmetic, in the viewer's local time (a calendar grid is what the wall clock shows).
/** An `EventCalendar` view: one day, a week or a month. */
export type CalendarView = 'day' | 'week' | 'month';
/** One calendar event: id, start and end, title, all-day flag, accent colour, and whether it may be moved. */
export type CalendarEvent = {
	id: string | number;
	start: Date;
	end: Date;
	title: string;
	allDay?: boolean;
	/** A CSS colour for the event's accent; the brand colour by default. */
	color?: string;
	/** `false` locks a timed event against moving and resizing; `lockedReason` is its tooltip. */
	editable?: boolean;
	lockedReason?: string;
};
/** Where an event is drawn: a timed `box`, an all-day or multi-day `bar`, or a month cell's `pill`. */
export type EventRenderContext = { view: CalendarView; mode: 'box' | 'bar' | 'pill' };
/** The time range a drag on empty grid selected, for creating an event. */
export type CreateSlot = { start: Date; end: Date };

const DAY = 86_400_000;
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
export const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
/** Monday 00:00 of `d`'s week. */
export function startOfWeek(d: Date): Date {
	const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	return addDays(x, -((x.getDay() + 6) % 7));
}
/** A timed box when the event starts and ends on one day; otherwise a bar across the all-day band. */
export const isTimed = (e: CalendarEvent) => e.allDay !== true && sameDay(e.start, e.end) && e.end.getTime() - e.start.getTime() < DAY;
/** The first day shown by `view` around `date`. */
export const viewStart = (view: CalendarView, date: Date) => (view === 'day' ? new Date(date.getFullYear(), date.getMonth(), date.getDate()) : startOfWeek(date));
/** `date` moved one view back or forward. */
export function step(view: CalendarView, date: Date, by: -1 | 1): Date {
	if (view !== 'month') return addDays(date, by * (view === 'day' ? 1 : 7));
	return new Date(date.getFullYear(), date.getMonth() + by, 1);
}
/** Whole weeks, Monday first, covering `date`'s month. */
export function monthGrid(date: Date): Date[] {
	const first = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1));
	const last = new Date(date.getFullYear(), date.getMonth() + 1, 0);
	const days: Date[] = [];
	for (let d = first; d <= last || days.length % 7 !== 0; d = addDays(d, 1)) days.push(d);
	return days;
}
/** Events overlapping `day` (any part of it). */
export const onDay = (events: readonly CalendarEvent[], day: Date) => {
	const from = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
	return events.filter((e) => (e.start.getTime() < from + DAY && e.end.getTime() > from) || sameDay(e.start, day));
};
/**
 * Side-by-side lanes for overlapping timed events: each event's lane, and the lane count of the cluster it overlaps
 * with, so a cluster shares its column's width and a lone event takes all of it.
 */
export function lanes(events: readonly CalendarEvent[]): Map<CalendarEvent['id'], { lane: number; of: number }> {
	const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
	const out = new Map<CalendarEvent['id'], { lane: number; of: number }>();
	let cluster: CalendarEvent[] = [], ends: number[] = [], clusterEnd = -Infinity;
	const close = () => { for (const e of cluster) out.get(e.id)!.of = ends.length; cluster = []; ends = []; };
	for (const e of sorted) {
		if (e.start.getTime() >= clusterEnd) close();
		let lane = ends.findIndex((end) => end <= e.start.getTime());
		if (lane === -1) lane = ends.length;
		ends[lane] = e.end.getTime();
		clusterEnd = Math.max(clusterEnd, e.end.getTime());
		out.set(e.id, { lane, of: 0 });
		cluster.push(e);
	}
	close();
	return out;
}
/** `HH:MM`, 24-hour. */
export const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
