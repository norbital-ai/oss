/** Calendar date for an instant in an IANA timezone, formatted as YYYY-MM-DD. */
export function calendarDateInTimeZone(value: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(value);
	const valueFor = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${valueFor('year')}-${valueFor('month')}-${valueFor('day')}`;
}

/** Move an ISO calendar date without applying the browser's local timezone. */
export function shiftCalendarDate(value: string, days: number): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new Error('Calendar date must use YYYY-MM-DD.');
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) throw new Error('Calendar date is invalid.');
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}
