/**
 * The five-field cron a manifest declares, and the next instant it names.
 *
 * This is the whole of cron in the repo. It began on the host, because that was where a schedule
 * was read; it lives here because a schedule is now read by the guest, which is the only party that
 * can see what a release declares. `roll` is its one caller, and the host never learns the grammar.
 *
 * It is hand-written rather than a dependency, and the trade is worth stating twice over. The guest
 * is a `node:vm` context with an explicit globals list and no package resolution at all, so a
 * dependency here is not a lockfile edit but a bundling problem; and the host that used to own this
 * ships as an esbuild bundle with `--packages=external`, where a new runtime dependency has to exist
 * in the image too. Five numeric fields against a table of cases is a smaller surface than either.
 * What it costs is reach: the supported grammar below is the classic Vixie subset and nothing more.
 *
 * Supported: `*`, `a`, `a-b`, `*` / `a` / `a-b` with a `/step`, and comma-separated lists of those,
 * in the order `minute hour day-of-month month day-of-week`. Day-of-week accepts `0` and `7` for
 * Sunday. Every instant is UTC.
 *
 * Not supported, and rejected rather than misread: named months and weekdays (`JAN`, `MON`), the
 * `@hourly` family of macros, a seconds field, and the Quartz extensions `L`, `W`, `#` and `?`. An
 * expression this cannot interpret comes back `Rejected` with a reason — never as a silently
 * different schedule, and never as "never fires".
 */

/** One field's numeric domain, named so a rejection can say which field was wrong. */
type Bounds = Readonly<{ readonly name: string; readonly min: number; readonly max: number }>;

const FIELDS: ReadonlyArray<Bounds> = [
	{ name: 'minute', min: 0, max: 59 },
	{ name: 'hour', min: 0, max: 23 },
	{ name: 'day-of-month', min: 1, max: 31 },
	{ name: 'month', min: 1, max: 12 },
	// 7 is accepted and folded onto 0: both spell Sunday in every cron in the wild.
	{ name: 'day-of-week', min: 0, max: 7 }
];

/**
 * A parsed expression, as sets plus the two wildcard flags the day rule needs.
 *
 * `dayOfMonthIsWildcard` and `dayOfWeekIsWildcard` are carried separately from the value sets
 * because the classic rule cannot be expressed by the sets alone: when *both* day fields are
 * restricted a day matches if *either* does, and `*` expands to every value, so a set that happens
 * to hold every day is indistinguishable from a literal `*` once expanded.
 */
type CronFields = Readonly<{
	readonly minutes: ReadonlyArray<number>;
	readonly hours: ReadonlyArray<number>;
	readonly daysOfMonth: ReadonlyArray<number>;
	readonly months: ReadonlyArray<number>;
	readonly daysOfWeek: ReadonlyArray<number>;
	readonly dayOfMonthIsWildcard: boolean;
	readonly dayOfWeekIsWildcard: boolean;
}>;

type CronParse =
	| Readonly<{ readonly _tag: 'Parsed'; readonly fields: CronFields }>
	| Readonly<{ readonly _tag: 'Rejected'; readonly reason: string }>;

type CronNext =
	| Readonly<{ readonly _tag: 'Next'; readonly epochMs: number }>
	| Readonly<{ readonly _tag: 'Rejected'; readonly reason: string }>;

type FieldParse =
	| Readonly<{ readonly _tag: 'Values'; readonly values: ReadonlyArray<number> }>
	| Readonly<{ readonly _tag: 'Rejected'; readonly reason: string }>;

/** Reads one whole number, refusing the empty string and anything `Number` would coerce. */
const integer = (text: string): number | undefined =>
	/^\d+$/.test(text) ? Number.parseInt(text, 10) : undefined;

/** Expands one comma-separated field into its value set, or says why it could not. */
const parseField = (input: string, bounds: Bounds): FieldParse => {
	const rejected = (reason: string): FieldParse => ({
		_tag: 'Rejected',
		reason: `${bounds.name} field ${JSON.stringify(input)}: ${reason}`
	});
	if (input.length === 0) return rejected('is empty');
	const collected = new Set<number>();
	for (const term of input.split(',')) {
		const parts = term.split('/');
		const range = parts[0];
		const stepText = parts[1];
		if (parts.length > 2 || range === undefined || range.length === 0) {
			return rejected(`term ${JSON.stringify(term)} is not a range or a range with one step`);
		}
		const step = stepText === undefined ? 1 : integer(stepText);
		if (step === undefined || step < 1) {
			return rejected(`step ${JSON.stringify(stepText ?? '')} is not a positive whole number`);
		}
		const span = ((): readonly [number, number] | string => {
			if (range === '*') return [bounds.min, bounds.max];
			const edges = range.split('-');
			const low = integer(edges[0] ?? '');
			if (low === undefined) return `${JSON.stringify(range)} is not a number, a range, or "*"`;
			if (edges.length === 1) {
				// A bare value with a step means "from here to the end of the field", which is what
				// `5/15` has always meant; without a step it is that single value.
				return stepText === undefined ? [low, low] : [low, bounds.max];
			}
			const high = edges.length === 2 ? integer(edges[1] ?? '') : undefined;
			if (high === undefined) return `${JSON.stringify(range)} is not a valid range`;
			if (high < low) return `${JSON.stringify(range)} runs backwards`;
			return [low, high];
		})();
		if (typeof span === 'string') return rejected(span);
		if (span[0] < bounds.min || span[1] > bounds.max) {
			return rejected(`${JSON.stringify(range)} falls outside ${bounds.min}-${bounds.max}`);
		}
		for (let value = span[0]; value <= span[1]; value += step) collected.add(value);
	}
	return { _tag: 'Values', values: Array.from(collected).toSorted((a, b) => a - b) };
};

export const parse = (expression: string): CronParse => {
	const terms = expression.trim().split(/\s+/);
	if (terms.length !== 5) {
		return {
			_tag: 'Rejected',
			reason: `expected 5 whitespace-separated fields, found ${expression.trim().length === 0 ? 0 : terms.length}`
		};
	}
	const parsed: Array<ReadonlyArray<number>> = [];
	for (let index = 0; index < FIELDS.length; index += 1) {
		const bounds = FIELDS[index];
		const term = terms[index];
		if (bounds === undefined || term === undefined) {
			return { _tag: 'Rejected', reason: 'expected 5 whitespace-separated fields' };
		}
		const field = parseField(term, bounds);
		if (field._tag === 'Rejected') return field;
		parsed.push(field.values);
	}
	const [minutes, hours, daysOfMonth, months, weekdays] = parsed;
	if (
		minutes === undefined ||
		hours === undefined ||
		daysOfMonth === undefined ||
		months === undefined ||
		weekdays === undefined
	) {
		return { _tag: 'Rejected', reason: 'expected 5 whitespace-separated fields' };
	}
	return {
		_tag: 'Parsed',
		fields: {
			minutes,
			hours,
			daysOfMonth,
			months,
			daysOfWeek: [...new Set(weekdays.map((day) => day % 7))].toSorted((a, b) => a - b),
			dayOfMonthIsWildcard: terms[2] === '*',
			dayOfWeekIsWildcard: terms[4] === '*'
		}
	};
};

/**
 * The classic day rule: restrict neither and every day matches; restrict one and it decides; restrict
 * both and a day matching *either* is a match. The last clause is the surprising one and it is not a
 * bug — `0 0 1 * 1` is "the first of the month and every Monday", not "Mondays that are the first".
 */
const dayMatches = (fields: CronFields, date: Date): boolean => {
	if (!fields.months.includes(date.getUTCMonth() + 1)) return false;
	const byMonth = fields.daysOfMonth.includes(date.getUTCDate());
	const byWeek = fields.daysOfWeek.includes(date.getUTCDay());
	if (fields.dayOfMonthIsWildcard && fields.dayOfWeekIsWildcard) return true;
	if (fields.dayOfMonthIsWildcard) return byWeek;
	if (fields.dayOfWeekIsWildcard) return byMonth;
	return byMonth || byWeek;
};

/** Four years, so a search crossing a leap day still terminates rather than looping. */
const SEARCH_DAYS = 366 * 4;

const MINUTE_MS = 60_000;

/**
 * The first instant one candidate day names that is not before the search boundary.
 *
 * The first day of the search is the only partial day: everything after it starts at 00:00, and
 * only the hour and minute that equaled the boundary's own are pinned below it.
 */
const firstMinuteOfDay = (
	fields: CronFields,
	year: number,
	month: number,
	day: number,
	boundaryHour: number,
	boundaryMinute: number,
	isFirstDay: boolean
): number | undefined => {
	for (const hour of fields.hours) {
		const earliestHour = isFirstDay ? boundaryHour : 0;
		if (hour < earliestHour) continue;
		const earliestMinute = isFirstDay && hour === boundaryHour ? boundaryMinute : 0;
		for (const minute of fields.minutes) {
			if (minute < earliestMinute) continue;
			return Date.UTC(year, month, day, hour, minute);
		}
	}
	return undefined;
};

/**
 * The first instant this expression names *strictly after* `afterEpochMs`, at minute granularity.
 *
 * Strictly after, and computed from the caller's `now` rather than from the previous due time, is
 * what keeps a host that was down for three hours from firing an hourly schedule three times when it
 * comes back. A missed occurrence is missed; the next one is the next one.
 */
export const nextRunAfter = (expression: string, afterEpochMs: number): CronNext => {
	if (!Number.isFinite(afterEpochMs)) {
		return { _tag: 'Rejected', reason: 'the instant to search from is not a finite time' };
	}
	const parsed = parse(expression);
	if (parsed._tag === 'Rejected') return parsed;
	const fields = parsed.fields;
	const from = new Date(Math.floor(afterEpochMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
	let year = from.getUTCFullYear();
	let month = from.getUTCMonth();
	let day = from.getUTCDate();
	for (let elapsed = 0; elapsed <= SEARCH_DAYS; elapsed += 1) {
		const midnight = new Date(Date.UTC(year, month, day));
		if (dayMatches(fields, midnight)) {
			const instant = firstMinuteOfDay(
				fields,
				year,
				month,
				day,
				from.getUTCHours(),
				from.getUTCMinutes(),
				elapsed === 0
			);
			if (instant !== undefined) return { _tag: 'Next', epochMs: instant };
		}
		const nextDay = new Date(Date.UTC(year, month, day + 1));
		year = nextDay.getUTCFullYear();
		month = nextDay.getUTCMonth();
		day = nextDay.getUTCDate();
	}
	return {
		_tag: 'Rejected',
		reason: `names no instant in the ${SEARCH_DAYS} days after the given time`
	};
};
