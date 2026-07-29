/**
 * A five-field cron matcher.
 *
 * Pod stores `cron_schedule` as an opaque string and leaves interpretation to the host, so a host
 * that wants to run scheduled automations needs exactly this much: given a schedule and a minute,
 * does it fire? Anything beyond that — catch-up for missed minutes, timezone policy, jitter — is a
 * scheduling decision that belongs to the host, not to the parser.
 *
 * Fields are `minute hour day-of-month month day-of-week`. Supported syntax per field: `*`, a
 * number, `a-b`, `a-b/s`, `*​/s`, and comma-separated lists of those. Day-of-week accepts 0-7 with
 * both 0 and 7 meaning Sunday, which is what operators expect from crontab.
 */

export type CronSchedule = {
	readonly minute: ReadonlySet<number>;
	readonly hour: ReadonlySet<number>;
	readonly dayOfMonth: ReadonlySet<number>;
	readonly month: ReadonlySet<number>;
	readonly dayOfWeek: ReadonlySet<number>;
	/**
	 * Whether either day field was restricted. Cron's one irregular rule lives here: when *both*
	 * day-of-month and day-of-week are restricted the schedule fires when *either* matches, not
	 * both — `0 0 1 * 1` is "the 1st, and every Monday", not "Mondays that fall on the 1st".
	 */
	readonly dayOfMonthRestricted: boolean;
	readonly dayOfWeekRestricted: boolean;
};

type FieldRange = { readonly min: number; readonly max: number };

const FIELDS: readonly FieldRange[] = [
	{ min: 0, max: 59 }, // minute
	{ min: 0, max: 23 }, // hour
	{ min: 1, max: 31 }, // day of month
	{ min: 1, max: 12 }, // month
	{ min: 0, max: 7 } //  day of week (7 normalises to 0)
];

function parseField(raw: string, range: FieldRange, label: string): Set<number> {
	const values = new Set<number>();
	for (const part of raw.split(',')) {
		const term = part.trim();
		if (!term) throw new Error(`Empty ${label} term in cron expression`);

		const [spec, stepText, ...excess] = term.split('/');
		if (excess.length > 0) throw new Error(`Invalid ${label} step in cron expression: ${term}`);
		let step = 1;
		if (stepText !== undefined) {
			step = Number(stepText);
			if (!Number.isInteger(step) || step < 1) {
				throw new Error(`Invalid ${label} step in cron expression: ${term}`);
			}
		}

		let from: number;
		let to: number;
		if (spec === '*') {
			from = range.min;
			to = range.max;
		} else if (spec.includes('-')) {
			const [startText, endText, ...rest] = spec.split('-');
			if (rest.length > 0) throw new Error(`Invalid ${label} range in cron expression: ${term}`);
			from = Number(startText);
			to = Number(endText);
		} else {
			from = Number(spec);
			to = from;
		}

		if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) {
			throw new Error(`Invalid ${label} value in cron expression: ${term}`);
		}
		if (from < range.min || to > range.max) {
			throw new Error(
				`Out-of-range ${label} in cron expression: ${term} (expected ${range.min}-${range.max})`
			);
		}
		for (let value = from; value <= to; value += step) {
			// 7 and 0 are the same day; normalising here keeps the match a plain set lookup.
			values.add(range.max === 7 && value === 7 ? 0 : value);
		}
	}
	return values;
}

export function parseCron(expression: string): CronSchedule {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			`Cron expression must have 5 fields (minute hour day-of-month month day-of-week); received ${parts.length}: ${expression}`
		);
	}
	const labels = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = parts.map((part, index) =>
		parseField(part, FIELDS[index], labels[index])
	);
	return {
		minute,
		hour,
		dayOfMonth,
		month,
		dayOfWeek,
		dayOfMonthRestricted: parts[2] !== '*',
		dayOfWeekRestricted: parts[4] !== '*'
	};
}

/** Whether `date` falls on a minute this schedule fires. Evaluated in the host's local time. */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
	if (!schedule.minute.has(date.getMinutes())) return false;
	if (!schedule.hour.has(date.getHours())) return false;
	if (!schedule.month.has(date.getMonth() + 1)) return false;

	const dayOfMonthMatches = schedule.dayOfMonth.has(date.getDate());
	const dayOfWeekMatches = schedule.dayOfWeek.has(date.getDay());
	if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
		return dayOfMonthMatches || dayOfWeekMatches;
	}
	return dayOfMonthMatches && dayOfWeekMatches;
}
