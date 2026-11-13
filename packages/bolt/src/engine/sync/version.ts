import { BigDecimal } from 'effect';

const NUMBER = '^-?[0-9]+([.][0-9]+)?$';
const INSTANT = '^[0-9]{4}-[0-9]{2}-[0-9]{2}';
const number = new RegExp(NUMBER), instant = new RegExp(INSTANT);

/** Numeric and ISO versions compare by value; other changed tokens have no ordering. */
export const remoteVersionNewer = (a: string, b: string): boolean => {
	if (a === b) return false;
	if (number.test(a) && number.test(b)) return BigDecimal.isGreaterThan(BigDecimal.fromStringUnsafe(a), BigDecimal.fromStringUnsafe(b));
	const [x, y] = [Date.parse(a), Date.parse(b)];
	return instant.test(a) && instant.test(b) && Number.isFinite(x) && Number.isFinite(y)
		? x > y
		: true;
};

/** Merge an acknowledgement with the current map. Unordered tokens may replace only an unchanged observation. */
export const replaceVersionSql = (incoming: string, current: string, unchanged: string): string =>
	`CASE WHEN ${incoming} IS NULL THEN false
		WHEN ${current} IS NULL OR ${incoming} = ${current} THEN true
		WHEN ${incoming} ~ '${NUMBER}' AND ${current} ~ '${NUMBER}'
			THEN ${incoming}::numeric > ${current}::numeric
		WHEN ${incoming} ~ '${INSTANT}' AND ${current} ~ '${INSTANT}'
			AND pg_input_is_valid(${incoming}, 'timestamptz') AND pg_input_is_valid(${current}, 'timestamptz')
			THEN date_trunc('milliseconds', ${incoming}::timestamptz) > date_trunc('milliseconds', ${current}::timestamptz)
		ELSE ${unchanged} END`;
