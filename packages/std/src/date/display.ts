import type { DateRangeWire } from './wire.js';
import { parseUtcInstant } from './wire.js';

export type FormatInstantOptions = Intl.DateTimeFormatOptions & {
	locale?: string;
};

/** Format a stored UTC ISO instant in the viewer's local timezone. */
export function formatUtcInstantLocal(
	value: string,
	options: FormatInstantOptions = {}
): string {
	const { locale = 'en-US', ...intlOptions } = options;
	return new Intl.DateTimeFormat(locale, intlOptions).format(parseUtcInstant(value));
}

/** Format a stored UTC date-range in the viewer's local timezone. */
export function formatDateRangeLocal(
	range: DateRangeWire | null | undefined,
	options: FormatInstantOptions = {}
): string {
	if (!range?.start && !range?.end) return '—';
	const { locale = 'en-US', dateStyle = 'medium', ...intlOptions } = options;
	const formatter = new Intl.DateTimeFormat(locale, { dateStyle, ...intlOptions });
	const formatBound = (value?: string | null) => {
		if (!value) return '...';
		return formatter.format(parseUtcInstant(value));
	};
	return `${formatBound(range.start)} – ${formatBound(range.end)}`;
}
