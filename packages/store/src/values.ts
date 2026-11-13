// Value types the store's literals and rows are made of: JSON. A decimal is its exact text, a date and an instant their
// ISO text; arithmetic on them is Effect's `BigDecimal` and `DateTime`.
/** A JSON value. Structural, so `Predicate.isObject` narrows it to its object and list arms. */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type { Duration, Offset } from './lang/vars.ts';
// Plain text, not brands: decode checks the spelling at every boundary.
/** A decimal's exact text (`'12.50'`). */
export type Decimal = string;
/** A calendar day, `YYYY-MM-DD`. */
export type PlainDate = string;
/** An instant, ISO UTC text (`2026-01-05T09:30:00.000Z`). */
export type Instant = string;
export declare const brand: unique symbol;

/** A row id, branded by its table so an id of one table never passes for another's. */
export type Id<T extends string> = string & { readonly [brand]: T };
/** A typed reference to one row: its table (`model`) and id; a polymorphic ref's value. */
export type RecordRef<T extends string = string> = {
	[K in T]: { readonly model: K; readonly id: Id<K> };
}[T];
/** A `time` field's value: a validated time-of-day string. */
export type PlainTime = string & { readonly [brand]: 'PlainTime' };
/** A `period` of dates: `from` and `to` inclusive; `to: null` is open-ended. */
export type DatePeriod = { readonly from: PlainDate; readonly to: PlainDate | null };
/** A `period` of instants: `start` inclusive, `end` exclusive; `end: null` is open-ended. */
export type InstantPeriod = { readonly start: Instant; readonly end: Instant | null };
/** A `vector` field's value: its numbers. */
export type Vector = readonly number[];
/** A `file` field's value: a handle to a stored file, never its bytes. */
export type FileRef = {
	readonly id: string;
	readonly name: string;
	readonly mime: string;
	readonly size?: number;
};

/** A `point` field's value: latitude and longitude in degrees. */
export type Point = { readonly lat: number; readonly lng: number };
/** A geographic area a `point` filter tests: a polygon, or a bounding box of two corners. */
export type Shape =
	{ readonly polygon: readonly Point[] } | { readonly bbox: readonly [Point, Point] };
