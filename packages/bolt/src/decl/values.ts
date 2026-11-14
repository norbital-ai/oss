// Value types and literal grammars. Type-only: a row is JSON. A decimal is its exact text, a date `YYYY-MM-DD` and an
// instant ISO UTC text; their arithmetic is Effect's `BigDecimal` and `DateTime`.
import type { Decimal, Duration, Instant, Offset, PlainDate } from '@norbital-ai/store';
export type { Decimal, Duration, Instant, Offset, PlainDate };
export declare const brand: unique symbol;

/** A `time` field's value: a validated time-of-day string. */
export type PlainTime = string & { readonly [brand]: 'PlainTime' };
/** A row id, branded by its model so an id of one model never passes for another's. */
export type Id<C extends string> = string & { readonly [brand]: C };
/** A typed reference to one record: its model and id. */
export type RecordRef<C extends string = string> = {
	[K in C]: { readonly model: K; readonly id: Id<K> };
}[C];

/** A `period` of dates: `from` and `to` inclusive; `to: null` is open-ended. */
export type DatePeriod = { readonly from: PlainDate; readonly to: PlainDate | null }; // inclusive
/** A `period` of instants: `start` inclusive, `end` exclusive; `end: null` is open-ended. */
export type InstantPeriod = { readonly start: Instant; readonly end: Instant | null }; // closed-open
/** A `point` field's value: latitude and longitude in degrees. */
export type { Point } from '@norbital-ai/host-api';
/** A `vector` field's value: its numbers. */
export type Vector = readonly number[];
/** A `file` field's value: a handle to a stored file (id, name, MIME type), never its bytes. */
export type FileRef = {
	readonly [brand]: 'FileRef';
	readonly id: Id<'sys_file'>;
	readonly name: string;
	readonly mime: string;
};

// ponytail: ISO 4217 is not enumerated; upper case keeps it apart from field names, the build checks the code list.
/** An ISO 4217 currency code (`SGD`, `USD`). */
export type CurrencyCode = Uppercase<string>;
/** A key of `src/i18n/+messages.ts` or, outside catalog mode, a literal string. */
export type Msg = string;
/** An icon name as the ui's `Icon` takes it (an Iconify name such as `lucide:users`). */
export type IconName = string;
/** An IANA time zone name (`Asia/Singapore`). */
export type IanaZone = string;
/** An approval request's id (`PendingApproval.request_id`, `ApprovalHeld`). */
export type RequestId = string;
/** A MIME type or wildcard a `file` field accepts (`image/*`, `application/pdf`). */
export type MimePattern = `${string}/${string}`;

/** A byte size literal in KiB or MiB (`'512KiB'`, `'10MiB'`). */
export type Size = `${bigint}${'KiB' | 'MiB'}`;
/** A rate literal: a count per unit or per duration (`'60/min'`, `'5/10min'`). */
export type Rate = `${bigint}/${'s' | 'min' | 'h' | 'd' | Duration}`;

export type { Json } from '@norbital-ai/store';
export type NonEmpty<T> = readonly [T, ...T[]];
