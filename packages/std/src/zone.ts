// std/zone: wall-clock ⇄ UTC in an IANA zone through Intl (std/date and std/calendar build on it).
/** Milliseconds in a UTC day. */
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
	let f = formats.get(zone);
	if (f === undefined) {
		f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit',
			day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
		formats.set(zone, f);
	}
	return f;
}

/** The zone-local calendar day and milliseconds into it of a UTC instant. */
export function localOf(ms: number, zone: string): { date: string; msOfDay: number } {
	const p: Record<string, string> = {};
	for (const x of format(zone).formatToParts(ms)) p[x.type] = x.value;
	const date = `${p['year']!.padStart(4, '0')}-${p['month']}-${p['day']}`;
	const msOfDay = ((Number(p['hour']) * 60 + Number(p['minute'])) * 60 + Number(p['second'])) * 1000 + (((ms % 1000) + 1000) % 1000);
	return { date, msOfDay };
}

/**
 * The UTC instant (ms) of a zone-local wall time, as Temporal's 'compatible': in a fold the earlier instant, in a gap
 * the wall time read with the offset before the gap (so it lands after it).
 */
export function utcOf(date: string, msOfDay: number, zone: string): number {
	const wall = Date.parse(`${date}T00:00:00Z`) + msOfDay;
	const offset = (t: number) => { const l = localOf(t, zone); return Date.parse(`${l.date}T00:00:00Z`) + l.msOfDay - t; };
	const before = wall - offset(wall - DAY_MS), after = wall - offset(wall + DAY_MS);
	const fits = (t: number) => t + offset(t) === wall;
	return fits(before) ? before : fits(after) ? after : before;
}

export { DAY_MS };
