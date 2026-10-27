// Value types the store's literals and rows are made of. Type-only: the runtime values are std's (`Decimal`, and dates
// and instants as std's branded ISO strings).
import type { Decimal } from '@norbital-ai/std/decimal';
import type { Instant, PlainDate } from '@norbital-ai/std/date';
export type { Json } from '@norbital-ai/std/wire';
export type { Decimal, Instant, PlainDate };
export declare const brand: unique symbol;

/** A row id, branded by its table so an id of one table never passes for another's. */
export type Id<T extends string> = string & { readonly [brand]: T };
/** A typed reference to one row: its table (`model`) and id; a polymorphic ref's value. */
export type RecordRef<T extends string = string> = {
	[K in T]: { readonly model: K; readonly id: Id<K> };
}[T];
/** A `time` field's value: a validated time-of-day string. */
export type PlainTime = string & { readonly [brand]: 'PlainTime' };
/** A `duration` field's value: whole seconds. */
export type Seconds = number & { readonly [brand]: 'Seconds' };
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

/** A duration literal: whole seconds, minutes, hours or days (`'30s'`, `'15min'`, `'2h'`, `'7d'`). */
export type Duration = `${bigint}${'s' | 'min' | 'h' | 'd'}`;
/** A signed duration from now or today (`'-7d'`, `'+1h'`); `''` is none. */
export type Offset = `${'+' | '-'}${Duration}` | '';
/** A `point` field's value: latitude and longitude in degrees. */
export type Point = { readonly lat: number; readonly lng: number };
/** A calendar unit: `{ startOf }` is the first day of the unit containing today (weeks start Monday). */
export type CalendarUnit = 'week' | 'month' | 'quarter' | 'year';
/** A geographic area a `point` filter tests: a polygon, or a bounding box of two corners. */
export type Shape =
	{ readonly polygon: readonly Point[] } | { readonly bbox: readonly [Point, Point] };
