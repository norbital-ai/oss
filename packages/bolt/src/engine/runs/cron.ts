// Cron (rule 52): 5 fields or a macro, computed in its zone. A nonexistent local time (spring forward) fires at the next
// valid instant; a repeated one (fall back) fires once, at its first occurrence.
import { BoltError } from '../contracts.ts';

const MACROS: { readonly [m: string]: string } = {
	'@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@hourly': '0 * * * *',
};
const NAMES = [
	{},
	{},
	{},
	Object.fromEntries(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map((n, i) => [n, i + 1])),
	Object.fromEntries(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((n, i) => [n, i])),
] as { readonly [n: string]: number }[];
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;

export type Cron = { minutes: readonly number[]; hours: readonly number[]; days: ReadonlySet<number>; months: ReadonlySet<number>;
	weekdays: ReadonlySet<number>; anyDay: boolean; anyWeekday: boolean };

/** Parses at build (rule 52); a bad expression is `invalidCron`. */
export function parseCron(expr: string): Cron {
	const text = MACROS[expr.trim()] ?? expr.trim();
	const parts = text.split(/\s+/);
	const bad = (why: string) => new BoltError('invalidCron', 'decode', `'${expr}' is not a cron: ${why}`);
	if (parts.length !== 5) throw bad('a cron is 5 fields or a macro');
	const sets = parts.map((part, i) => {
		const [lo, hi] = RANGES[i]!;
		const num = (s: string) => {
			const n = NAMES[i]![s.toLowerCase()] ?? (/^\d+$/.test(s) ? Number(s) : NaN);
			if (!(n >= lo && n <= hi)) throw bad(`'${s}' is out of range in field ${i + 1}`);
			return n;
		};
		const out = new Set<number>();
		for (const item of part.split(',')) {
			const [range = '', stepText] = item.split('/');
			const step = stepText === undefined ? 1 : Number(stepText);
			if (!(Number.isInteger(step) && step > 0)) throw bad(`'${item}' has a bad step`);
			const [a, b] = range === '*' ? [lo, hi] : range.includes('-') ? range.split('-').map(num) as [number, number]
				: [num(range), stepText === undefined ? num(range) : hi];
			if (a > b) throw bad(`'${item}' is an empty range`);
			for (let n = a; n <= b; n += step) out.add(i === 4 && n === 7 ? 0 : n);
		}
		return out;
	});
	const sorted = (s: Set<number>) => [...s].sort((x, y) => x - y);
	return { minutes: sorted(sets[0]!), hours: sorted(sets[1]!), days: sets[2]!, months: sets[3]!, weekdays: sets[4]!,
		anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' };
}

/** Rule 52a: slots of a cron whose period is 5 minutes or more are bucketed; the shortest gap between minutes decides. */
export function periodAtLeast5Min(c: Cron): boolean {
	const m = c.minutes;
	if (m.length === 1) return true;
	const gaps = m.slice(1).map((x, i) => x - m[i]!);
	return Math.min(...gaps, 60 - m.at(-1)! + m[0]!) >= 5;
}

const formats = new Map<string, Intl.DateTimeFormat>();
/** The zone's offset at `utc` in ms (local = utc + offset). */
function offset(utc: number, tz: string): number {
	let f = formats.get(tz);
	if (f === undefined) formats.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
		year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
	const p = Object.fromEntries(f.formatToParts(utc).map((x) => [x.type, Number(x.value)]));
	return Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!) - Math.floor(utc / 1000) * 1000;
}
/** A local wall time → its instant: the first of a repeated time, the end of the gap for a nonexistent one. */
function instantOf(wall: number, tz: string): number {
	const a = wall - offset(wall - 86_400_000, tz), b = wall - offset(wall + 86_400_000, tz);
	const valid = [a, b].filter((u) => u + offset(u, tz) === wall);
	if (valid.length > 0) return Math.min(...valid);
	// a gap: the transition lies between the two guesses; the first minute on the far side is the next valid instant
	let lo = Math.min(a, b), hi = Math.max(a, b);
	const after = offset(hi, tz);
	while (hi - lo > 60_000) {
		const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000;
		if (offset(mid, tz) === after) hi = mid; else lo = mid;
	}
	return hi;
}

/** The first slot strictly after `after` (epoch ms), in `tz`. */
export function nextSlot(c: Cron, after: number, tz: string): number {
	const local = new Date(after + offset(after, tz));
	const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - 86_400_000;
	for (let day = 0; day < 366 * 8 + 2; day++) {
		const d = new Date(start + day * 86_400_000);
		if (!c.months.has(d.getUTCMonth() + 1)) continue;
		const dom = c.days.has(d.getUTCDate()), dow = c.weekdays.has(d.getUTCDay());
		// Vixie: with both restricted, either matches
		if (!(c.anyDay ? dow : c.anyWeekday ? dom : dom || dow)) continue;
		for (const h of c.hours) for (const m of c.minutes) {
			const at = instantOf(d.getTime() + h * 3_600_000 + m * 60_000, tz);
			if (at > after) return at;
		}
	}
	throw new BoltError('invalidCron', 'decode', 'the cron never fires');
}
