import type { CollectionField } from '@norbital-ai/platform-utils/collection';
import type { MessageVars } from '@norbital-ai/std/i18n';
import { formatDateRangeLocal } from '@norbital-ai/std/date';
import { humanize } from '@norbital-ai/std/string';
import { formatPhoneDisplay, phoneCountryFromLocale } from './phone_number/phone_number.utils.js';

type Translate = (key: string, vars?: MessageVars) => string;
export type { Translate };

/** English fallbacks so callers without an i18n handle render stable text. */
const FALLBACK_TEXT: Record<string, string> = {
	'dataRenderer.null': '—',
	'dataRenderer.true': 'Yes',
	'dataRenderer.false': 'No',
	'dataRenderer.present': 'Present'
};

function resolveText(t: Translate | undefined, key: string): string {
	return t ? t(key) : (FALLBACK_TEXT[key] ?? key);
}

function dateValue(input: unknown): Date | null {
	const value = input instanceof Date ? input : new Date(String(input));
	return Number.isNaN(value.getTime()) ? null : value;
}

function objectProperty(input: unknown, key: string): unknown {
	return input != null && typeof input === 'object' ? Reflect.get(input, key) : undefined;
}

export function formatStructuredValue(value: unknown, pretty = false): string {
	if (value == null) return '—';
	if (typeof value !== 'object') return String(value);
	try {
		return JSON.stringify(value, null, pretty ? 2 : undefined) ?? String(value);
	} catch (cause) {
		console.warn('Could not serialize a structured field value.', cause);
		return String(value);
	}
}

function formatTimestampRange(value: unknown, locale: string, t?: Translate): string {
	const lower = objectProperty(value, 'lower') ?? objectProperty(value, 'start');
	const upper = objectProperty(value, 'upper') ?? objectProperty(value, 'end');
	let start = lower;
	let end = upper;
	if (typeof value === 'string') {
		if (value === 'empty') return resolveText(t, 'dataRenderer.null');
		const match = value.match(/^[[(]\"?([^,\"]*)\"?,\"?([^\]\)\"]*)\"?[\])]$/);
		if (!match) return value;
		start = match[1] || null;
		end = match[2] || null;
	}
	const timestampField: CollectionField = {
		name: 'range_boundary',
		kind: 'timestamptz',
		nullable: true
	};
	return `${formatScalar(timestampField, start, locale, t)} – ${end == null ? resolveText(t, 'dataRenderer.present') : formatScalar(timestampField, end, locale, t)}`;
}

function formatDateRange(value: unknown, locale: string): string {
	const start = objectProperty(value, 'start');
	const end = objectProperty(value, 'end');
	try {
		return formatDateRangeLocal(
			{
				start: typeof start === 'string' ? start : null,
				end: typeof end === 'string' ? end : null
			},
			{ locale, dateStyle: 'medium' }
		);
	} catch {
		return formatStructuredValue(value);
	}
}

function formatScalar(
	field: CollectionField,
	value: unknown,
	locale: string,
	t?: Translate
): string {
	if (value == null || value === '') return resolveText(t, 'dataRenderer.null');
	if (field.relation || field.kind === 'file') return String(value);

	switch (field.kind) {
		case 'boolean':
			return value === true
				? resolveText(t, 'dataRenderer.true')
				: value === false
					? resolveText(t, 'dataRenderer.false')
					: resolveText(t, 'dataRenderer.null');
		case 'numeric':
		case 'number':
		case 'integer': {
			const numeric = typeof value === 'number' ? value : Number(value);
			return Number.isFinite(numeric)
				? new Intl.NumberFormat(locale).format(numeric)
				: String(value);
		}
		case 'money': {
			const amount = objectProperty(value, 'value');
			const currency = objectProperty(value, 'currency');
			if (typeof amount !== 'number' || typeof currency !== 'string')
				return resolveText(t, 'dataRenderer.null');
			try {
				return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount);
			} catch {
				return `${currency} ${new Intl.NumberFormat(locale).format(amount)}`;
			}
		}
		case 'date': {
			const date = dateValue(value);
			return date
				? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(date)
				: String(value);
		}
		case 'timestamp':
		case 'timestamptz': {
			const date = dateValue(value);
			return date
				? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
				: String(value);
		}
		case 'date-range':
			return formatDateRange(value, locale);
		case 'geolocation': {
			const address = objectProperty(value, 'formatted_address');
			return typeof address === 'string' ? address : resolveText(t, 'dataRenderer.null');
		}
		case 'tstzrange':
			return formatTimestampRange(value, locale, t);
		case 'enum':
			return humanize(String(value));
		case 'phone':
			return formatPhoneDisplay(String(value), phoneCountryFromLocale(locale));
		case 'clock_time':
		case 'text':
		case 'string':
		case 'uuid':
			return String(value);
		default:
			return formatStructuredValue(value);
	}
}

export function formatDataValue(
	field: CollectionField,
	value: unknown,
	locale = 'en-US',
	t?: Translate
): string {
	return field.array && Array.isArray(value)
		? value
				.map((item) => formatScalar(field, item, locale, t))
				.join(', ')
		: formatScalar(field, value, locale, t);
}
