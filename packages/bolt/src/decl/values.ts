// Value types and literal grammars (§3.3.9, §3.3.10 "values"). Type-only: the runtime values are std's, and a row
// holds exactly them (the guest prelude and `$bolt` decode the wire into them): a `Decimal` instance, and a date and an
// instant as std's branded ISO strings.
import type { CurrencyCode as Iso4217, Decimal } from '@norbital-ai/std/decimal';
import type { Instant, PlainDate } from '@norbital-ai/std/date';
export type { Decimal, Instant, PlainDate };
export declare const brand: unique symbol;

/** A `time` field's value: a time of day. */
export interface PlainTime { readonly [brand]: 'PlainTime' }
/** A `duration` field's value: whole seconds. */
export type Seconds = number & { readonly [brand]: 'Seconds' };
/** A row id, branded by its collection so an id of one collection never passes for another's. */
export type Id<C extends string> = string & { readonly [brand]: C };
/** A typed reference to one record: its collection and id. */
export type RecordRef<C extends string = string> = { [K in C]: { readonly collection: K; readonly id: Id<K> } }[C];

/** A `period` of dates: `from` and `to` inclusive; `to: null` is open-ended. */
export type DatePeriod = { readonly from: PlainDate; readonly to: PlainDate | null };        // inclusive
/** A `period` of instants: `start` inclusive, `end` exclusive; `end: null` is open-ended. */
export type InstantPeriod = { readonly start: Instant; readonly end: Instant | null };        // closed-open
/** A `point` field's value: latitude and longitude in degrees. */
export type Point = { readonly lat: number; readonly lng: number };
/** A `vector` field's value: its numbers. */
export type Vector = readonly number[];
/** A `file` field's value: a handle to a stored file (id, name, MIME type), never its bytes. */
export interface FileRef { readonly [brand]: 'FileRef'; readonly id: Id<'sys_file'>; readonly name: string; readonly mime: string }

// ponytail: ISO 4217 is not enumerated; upper case keeps it apart from field names, the build checks the code list.
/** An ISO 4217 currency code (`SGD`, `USD`): a literal or std's branded `currency()`. */
export type CurrencyCode = Iso4217 | Uppercase<string>;
/** A key of `src/i18n/+messages.ts` or, outside catalog mode, a literal string. */
export type Msg = string;
/** An icon name as the ui's `Icon` takes it (an Iconify name such as `lucide:users`). */
export type IconName = string;
/** An IANA time zone name (`Asia/Singapore`). */
export type IanaZone = string;
/** A BCP 47 locale tag (`en`, `zh-CN`). */
export type LocaleTag = string;
/** A path under the workspace `assets/` directory (an app `banner`). */
export type AssetPath = string;
/** The name of a declared input field, as a `{ param }` operand names it. */
export type InputName = string;
/** An approval request's id (`PendingApproval.requestId`, `ApprovalHeld`). */
export type RequestId = string;
/** A MIME type or wildcard a `file` field accepts (`image/*`, `application/pdf`). */
export type MimePattern = `${string}/${string}`;

/** A duration literal: whole seconds, minutes, hours or days (`'30s'`, `'15min'`, `'2h'`, `'7d'`). */
export type Duration = `${bigint}${'s' | 'min' | 'h' | 'd'}`;
/** A signed duration from now or today (`'-7d'`, `'+1h'`); `''` is none. */
export type Offset = `${'+' | '-'}${Duration}` | '';
/** A byte size literal in KiB or MiB (`'512KiB'`, `'10MiB'`). */
export type Size = `${bigint}${'KiB' | 'MiB'}`;
/** A rate literal: a count per unit or per duration (`'60/min'`, `'5/10min'`). */
export type Rate = `${bigint}/${'s' | 'min' | 'h' | 'd' | Duration}`;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type NonEmpty<T> = readonly [T, ...T[]];
