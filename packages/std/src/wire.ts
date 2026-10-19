// std/wire (D6): the one wire value codec. `$dec` is the only tag: a decimal is `{ $dec: '1.20' }` in both directions
// (`Decimal.toJSON` emits it); dates and instants are their ISO strings, which std's branded `PlainDate`/`Instant` already
// are. SQL encoding, the guest prelude (which evaluates `reviveWire` from its source text), the page client, `ctx.existing`
// and the test kit all read the wire through here.
import { Decimal } from './decimal.ts';

/** A JSON value. */
export type Json =
	null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
/** A value the wire carries once encoded: JSON with std's `Decimal` at any depth; an `undefined` member is dropped. */
export type Wired =
	| null
	| boolean
	| number
	| string
	| Decimal
	| undefined
	| readonly Wired[]
	| { readonly [key: string]: Wired };

/**
 * The `JSON.parse` reviver of the wire: `{ $dec }` → std's `Decimal`; nothing else changes. Self-contained (it reads the
 * class std/decimal registers on `globalThis`), so the guest prelude runs it from `reviveWire.toString()`; where no std
 * decimal is loaded, a decimal stays its exact text.
 */
export function reviveWire(_key: string, value: unknown): unknown {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
	const text = '$dec' in value ? value.$dec : undefined;
	if (typeof text !== 'string') return value;
	for (const key in value) if (key !== '$dec') return value;
	const D = (globalThis as { readonly [k: symbol]: { of(text: string): unknown } | undefined })[
		Symbol.for('norbital.std.Decimal')
	];
	return D === undefined ? text : D.of(text);
}

/** A value as the wire carries it: each `Decimal` as `{ $dec }`; `undefined` is null in a list and dropped as a member. */
export function encodeWire(value: Wired): Json {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object') return value;
	if (value instanceof Decimal) return value.toJSON();
	if (Array.isArray(value)) return value.map(encodeWire);
	return Object.fromEntries(
		Object.entries(value).flatMap(([k, v]): [string, Json][] =>
			v === undefined ? [] : [[k, encodeWire(v)]]
		)
	);
}
