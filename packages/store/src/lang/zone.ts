// std/zone: wall-clock ⇄ UTC in an IANA zone through Intl (std/date and std/calendar build on it).
/** Milliseconds in a UTC day. */
const DAY_MS = 86_400_000;
const formats = new Map<string, Intl.DateTimeFormat>();

function format(zone: string): Intl.DateTimeFormat {
	let f = formats.get(zone);
	if (f === undefined) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone: zone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		});
		formats.set(zone, f);
	}
	return f;
}

/** The zone-local calendar day and milliseconds into it of a UTC instant. */
export function local_of(ms: number, zone: string): { date: string; ms_of_day: number } {
	const p: Record<string, string> = {};
	for (const x of format(zone).formatToParts(ms)) p[x.type] = x.value;
	const { year, month, day, hour, minute, second } = p;
	if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined)
		throw new RangeError('The zone formatter omitted a date or time part.');
	const date = `${year.padStart(4, '0')}-${month}-${day}`;
	const ms_of_day =
		((Number(hour) * 60 + Number(minute)) * 60 + Number(second)) * 1000 +
		(((ms % 1000) + 1000) % 1000);
	return { date, ms_of_day };
}

/**
 * The UTC instant (ms) of a zone-local wall time, as Temporal's 'compatible': in a fold the earlier instant, in a gap
 * the wall time read with the offset before the gap (so it lands after it).
 */
export function utc_of(date: string, ms_of_day: number, zone: string): number {
	const wall = Date.parse(`${date}T00:00:00Z`) + ms_of_day;
	const offset = (t: number) => {
		const l = local_of(t, zone);
		return Date.parse(`${l.date}T00:00:00Z`) + l.ms_of_day - t;
	};
	const before = wall - offset(wall - DAY_MS),
		after = wall - offset(wall + DAY_MS);
	const fits = (t: number) => t + offset(t) === wall;
	return fits(before) ? before : fits(after) ? after : before;
}

export { DAY_MS };
