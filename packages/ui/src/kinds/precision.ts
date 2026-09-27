// A time field's `precision` (§3.3.2): the unit a picker offers and the value it emits, snapped to that unit's start.
// Weeks start on Monday, as the workspace's weeks do (rule 16a). Pure: `YYYY-MM-DD` and `HH:MM` text only.
/** The date units a picker offers and snaps to. */
export type DatePrecision = 'year' | 'month' | 'week' | 'day';
/** The time units a picker offers and snaps to. */
export type TimePrecision = 'hour' | 'minute';
/** A field's `precision`: the unit picked and emitted, snapped to its start. */
export type Precision = DatePrecision | TimePrecision;
/** The coarse units a unit picker pages through (a year grid, a month grid, a month's week rows). */
export type Unit = Exclude<DatePrecision, 'day'>;

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
const text = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = day(s); d.setUTCDate(d.getUTCDate() + n); return text(d); };

/** The first day of the `p` unit holding `date`. */
export function unitStart(date: string, p: DatePrecision): string {
	if (p === 'year') return `${date.slice(0, 4)}-01-01`;
	if (p === 'month') return `${date.slice(0, 7)}-01`;
	if (p === 'week') return addDays(date, -((day(date).getUTCDay() + 6) % 7));
	return date.slice(0, 10);
}
/** The first day of the next `p` unit (an instant period's exclusive end). */
export function unitNext(date: string, p: DatePrecision): string {
	const d = day(unitStart(date, p));
	if (p === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
	else if (p === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
	else d.setUTCDate(d.getUTCDate() + (p === 'week' ? 7 : 1));
	return text(d);
}
/** The last day of the `p` unit holding `date` (a date period's inclusive `to`). */
export const unitEnd = (date: string, p: DatePrecision): string => addDays(unitNext(date, p), -1);

/** One picker page, each unit by its first day: 12 years (from a multiple of 12), a year's months, or a month's weeks. */
export function unitPage(anchor: string, u: Unit): string[] {
	const y = Number(anchor.slice(0, 4));
	if (u === 'year') { const from = y - (((y % 12) + 12) % 12); return Array.from({ length: 12 }, (_, i) => `${String(from + i).padStart(4, '0')}-01-01`); }
	if (u === 'month') return Array.from({ length: 12 }, (_, i) => `${anchor.slice(0, 4)}-${String(i + 1).padStart(2, '0')}-01`);
	const first = unitStart(`${anchor.slice(0, 7)}-01`, 'week'), next = unitNext(anchor, 'month');
	const out: string[] = [];
	for (let w = first; w < next; w = addDays(w, 7)) out.push(w);
	return out;
}
/** The page before or after the one holding `anchor`. */
export function pageStep(anchor: string, u: Unit, by: -1 | 1): string {
	const d = day(anchor);
	if (u === 'year') d.setUTCFullYear(d.getUTCFullYear() + 12 * by);
	else if (u === 'month') d.setUTCFullYear(d.getUTCFullYear() + by);
	else { d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + by); }
	return text(d);
}
/** `HH:MM` at the precision: `hour` drops the minutes. */
export const snapTime = (t: string, p: TimePrecision | undefined): string => p === 'hour' ? `${t.slice(0, 2)}:00` : t.slice(0, 5);
