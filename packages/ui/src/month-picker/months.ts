/**
 * A month as the calendar names it: `YYYY-MM`, UTC, no day.
 *
 * The month picker is the month-resolution member of the timestamp picker family: the calendar
 * picks a day, the time field a time, this a month or a span of months. Keys stay strings so a
 * template can hand one straight to a `period` column or a `contains_date` bound.
 */
export type MonthKey = string;

export type MonthRange = Readonly<{ start: MonthKey; end: MonthKey }>;

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/u;

export const isMonthKey = (value: unknown): value is MonthKey =>
	typeof value === 'string' && MONTH_KEY.test(value);

export const parseMonth = (key: MonthKey): Readonly<{ year: number; month: number }> => {
	const match = MONTH_KEY.exec(key);
	if (match === null) throw new Error(`Not a month key: ${key}`);
	return { year: Number(match[1]), month: Number(match[2]) };
};

export const monthKeyOf = (year: number, month: number): MonthKey =>
	`${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

export const currentMonthKey = (now: Date = new Date()): MonthKey =>
	monthKeyOf(now.getUTCFullYear(), now.getUTCMonth() + 1);

export const addMonths = (key: MonthKey, count: number): MonthKey => {
	const { year, month } = parseMonth(key);
	const index = year * 12 + (month - 1) + count;
	return monthKeyOf(Math.floor(index / 12), (index % 12) + 1);
};

/** Negative when `left` is earlier, zero when equal, positive when later. */
export const compareMonths = (left: MonthKey, right: MonthKey): number => left.localeCompare(right);

export const clampMonth = (key: MonthKey, min?: MonthKey, max?: MonthKey): MonthKey => {
	if (min !== undefined && compareMonths(key, min) < 0) return min;
	if (max !== undefined && compareMonths(key, max) > 0) return max;
	return key;
};

export const monthLabel = (
	locale: string,
	key: MonthKey,
	month: 'short' | 'long' = 'short'
): string =>
	new Intl.DateTimeFormat(locale, { month, year: 'numeric', timeZone: 'UTC' }).format(
		new Date(`${key}-01T00:00:00.000Z`)
	);

export const monthNames = (locale: string, month: 'short' | 'long' = 'short'): string[] => {
	const format = new Intl.DateTimeFormat(locale, { month, timeZone: 'UTC' });
	return Array.from({ length: 12 }, (_, index) =>
		format.format(new Date(Date.UTC(2000, index, 1)))
	);
};

export const rangeLabel = (locale: string, range: MonthRange): string =>
	range.start === range.end
		? monthLabel(locale, range.start)
		: `${monthLabel(locale, range.start)} – ${monthLabel(locale, range.end)}`;

export type MonthRangePreset = 'thisYear' | 'lastYear' | 'lastSixMonths' | 'lastTwelveMonths';

/** The spans a reporting surface asks for by name, anchored on the month `now` falls in. */
export const monthRangePreset = (preset: MonthRangePreset, now: Date = new Date()): MonthRange => {
	const current = currentMonthKey(now);
	const { year } = parseMonth(current);
	switch (preset) {
		case 'thisYear':
			return { start: monthKeyOf(year, 1), end: monthKeyOf(year, 12) };
		case 'lastYear':
			return { start: monthKeyOf(year - 1, 1), end: monthKeyOf(year - 1, 12) };
		case 'lastSixMonths':
			return { start: addMonths(current, -5), end: current };
		case 'lastTwelveMonths':
			return { start: addMonths(current, -11), end: current };
		default: {
			const _exhaustive: never = preset;
			return _exhaustive;
		}
	}
};

export const MONTH_RANGE_PRESETS: readonly MonthRangePreset[] = [
	'thisYear',
	'lastYear',
	'lastSixMonths',
	'lastTwelveMonths'
];
