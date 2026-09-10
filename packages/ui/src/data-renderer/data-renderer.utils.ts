import { MoneyValueSchema } from '@norbital-ai/std/finance';
import { Effect, Option, Schema } from 'effect';
import type { CollectionField } from '@norbital-ai/std/collection';
import type { MessageVars } from '@norbital-ai/std/i18n';
import { intlLocale } from '@norbital-ai/std/i18n';
import { formatDateRangeLocal } from '@norbital-ai/std/date';
import { humanize } from '@norbital-ai/std/string';
import { getGlobalLocale } from '#lib/i18n';
import {
	formatPhoneDisplay,
	phoneCountryFromLocale
} from '#lib/data-renderer/phone_number/phone_number.utils';
import { coerceNumericValue } from '#lib/data-renderer/numeric/numeric.values';
import { formatUtcDay, utcDayOf } from '#lib/data-renderer/utc-day';

export { coerceNumericValue } from '#lib/data-renderer/numeric/numeric.values';

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

const isString = Schema.is(Schema.String);
/** Bare `typeof x === 'object'` acceptance: arrays included, null excluded. */
const isObjectish = Schema.is(
	Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Array(Schema.Unknown)])
);

function dateValue(input: unknown): Date | null {
	const value = input instanceof Date ? input : new Date(String(input));
	return Number.isNaN(value.getTime()) ? null : value;
}

function objectProperty(input: unknown, key: string): unknown {
	return input != null && isObjectish(input) ? Reflect.get(input, key) : undefined;
}

const decodeMoneyValue = Schema.decodeUnknownOption(MoneyValueSchema);

export function formatStructuredValue(value: unknown, pretty = false): string {
	if (value == null) return '—';
	if (!isObjectish(value)) return String(value);
	return Effect.runSync(
		Effect.try(() => JSON.stringify(value, null, pretty ? 2 : undefined)).pipe(
			Effect.match({
				onFailure: (cause): string => {
					Effect.runSync(Effect.logWarning('Could not serialize a structured field value.', cause));
					return String(value);
				},
				onSuccess: (text): string => text ?? String(value)
			})
		)
	);
}

function formatInstantRange(
	field: CollectionField,
	value: unknown,
	locale: string,
	t?: Translate
): string {
	let start = objectProperty(value, 'start');
	let end = objectProperty(value, 'end');
	if (isString(value)) {
		if (value === 'empty') return resolveText(t, 'dataRenderer.null');
		const match = value.match(/^[[(]\"?([^,\"]*)\"?,\"?([^\]\)\"]*)\"?[\])]$/);
		if (!match) return value;
		start = match[1] || null;
		end = match[2] || null;
	}
	// Day precision reads each bound's canonical UTC day, the same prefix the database and the
	// workspace's `dateKey` read, so the boundary day prints the same for every viewer.
	if (field.precision === 'day') {
		const startDay = utcDayOf(start);
		const endDay = utcDayOf(end);
		return `${startDay == null ? String(start ?? resolveText(t, 'dataRenderer.null')) : formatUtcDay(startDay, locale)} – ${
			end == null
				? resolveText(t, 'dataRenderer.present')
				: endDay == null
					? String(end)
					: formatUtcDay(endDay, locale)
		}`;
	}
	const instantField: CollectionField = {
		name: 'range_boundary',
		kind: 'instant',
		nullable: true,
		...(field.precision === undefined ? {} : { precision: field.precision })
	};
	return `${formatScalar(instantField, start, locale, t)} – ${end == null ? resolveText(t, 'dataRenderer.present') : formatScalar(instantField, end, locale, t)}`;
}

function formatDateRange(value: unknown, locale: string): string {
	const start = objectProperty(value, 'start');
	const end = objectProperty(value, 'end');
	return Effect.runSync(
		Effect.try(() =>
			formatDateRangeLocal(
				{
					start: isString(start) ? start : null,
					end: isString(end) ? end : null
				},
				{ locale, dateStyle: 'medium' }
			)
		).pipe(Effect.orElseSucceed(() => formatStructuredValue(value)))
	);
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
			const numeric = coerceNumericValue(value);
			return numeric !== null ? new Intl.NumberFormat(locale).format(numeric) : String(value);
		}
		case 'money': {
			return Option.match(decodeMoneyValue(value), {
				onNone: () => resolveText(t, 'dataRenderer.null'),
				onSome: ({ value: amount, currency }) =>
					Effect.runSync(
						Effect.try(() =>
							new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount)
						).pipe(
							Effect.orElseSucceed(
								() => `${currency} ${new Intl.NumberFormat(locale).format(amount)}`
							)
						)
					)
			});
		}
		case 'instant': {
			// A day-precision instant names one canonical UTC day (`bolt_instant`'s reading), so it
			// is printed as that day for every viewer rather than shifted by the viewer's zone.
			if (field.precision === 'day') {
				const day = utcDayOf(value);
				if (day != null) return formatUtcDay(day, locale);
			}
			const date = dateValue(value);
			return date
				? new Intl.DateTimeFormat(
						locale,
						field.precision === 'day'
							? { dateStyle: 'medium' }
							: { dateStyle: 'medium', timeStyle: 'short' }
					).format(date)
				: String(value);
		}
		case 'instant_range':
			return formatInstantRange(field, value, locale, t);
		case 'geolocation': {
			const address = objectProperty(value, 'formatted_address');
			return isString(address) ? address : resolveText(t, 'dataRenderer.null');
		}
		case 'enum':
			return humanize(String(value));
		case 'phone':
			return formatPhoneDisplay(String(value), phoneCountryFromLocale(locale));
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
	locale = intlLocale(getGlobalLocale()),
	t?: Translate
): string {
	return field.array && Array.isArray(value)
		? value.map((item) => formatScalar(field, item, locale, t)).join(', ')
		: formatScalar(field, value, locale, t);
}
