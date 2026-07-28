import { z } from 'zod';
import { isClockTime, isUtcIsoInstant } from '@norbital-ai/std/date';

export { moneyZodSchema, type MoneyZod, type TMoney } from './money.js';
export { phoneZodSchema, type PhoneZod, type TPhone } from './phone.js';

/** Zod-backed builtin column kinds — shared with `column.custom` metadata. */
export const PLATFORM_ZOD_BUILTIN_KINDS = [
	'money',
	'date-range',
	'geolocation',
	'file',
	'phone',
	'clock_time'
] as const;

export type PlatformZodBuiltinKind = (typeof PLATFORM_ZOD_BUILTIN_KINDS)[number];

/** Stored UTC ISO instant (`…Z`). */
export const utcInstantSchema = z.string().refine(isUtcIsoInstant, {
	message: 'Expected UTC ISO instant (YYYY-MM-DDTHH:mm:ss.sssZ)'
});

export const dateRangeZodSchema = z.object({
	start: utcInstantSchema,
	end: utcInstantSchema
});

/** Local wall-clock time (`HH:mm`) with no date or timezone. */
export const clockTimeZodSchema = z.string().refine(isClockTime, {
	message: 'Expected local clock time (HH:mm)'
});

export const geolocationZodSchema = z.object({
	geometry: z
		.object({
			lon: z.number(),
			lat: z.number()
		})
		.nullable(),
	formatted_address: z.string(),
	type: z.literal('Point'),
	srid: z.number()
});

/** UUID reference to a platform `document_asset` record. */
export const fileZodSchema = z.uuid();

export type DateRangeZod = z.infer<typeof dateRangeZodSchema>;
export type GeolocationZod = z.infer<typeof geolocationZodSchema>;
export type FileZod = z.infer<typeof fileZodSchema>;

export type TDateRange = DateRangeZod;
export type TGeolocation = GeolocationZod;
