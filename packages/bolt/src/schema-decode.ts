import { Schema } from 'effect';
import type { Effect } from 'effect';

/**
 * Command contracts are `Schema.Top`. Decode APIs require `ConstraintDecoder`, whose
 * `DecodingServices` is `never`. Every fixed command schema has no decoding services; this is the
 * one place that records that fact so call sites can pass `Schema.Top` without widening `R`.
 */
export const decodeUnknownSchema = <S extends Schema.Top>(
	schema: S,
	input: unknown
): Effect.Effect<Schema.Schema.Type<S>, Schema.SchemaError, S['DecodingServices']> =>
	Schema.decodeUnknownEffect(schema)(input) as Effect.Effect<
		Schema.Schema.Type<S>,
		Schema.SchemaError,
		S['DecodingServices']
	>;

/** Single ownership for boundary predicates; callers import these instead of `Schema.is` one-liners. */
export const JsonObject = Schema.Record(Schema.String, Schema.Json);
export const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
export const isRecord = Schema.is(UnknownRecord);
export const isString = Schema.is(Schema.String);
export const isNumber = Schema.is(Schema.Number);
export const isBigint = Schema.is(Schema.BigInt);
export const isNonEmptyString = Schema.is(Schema.NonEmptyString);
export const isStringArray = Schema.is(Schema.Array(Schema.String));
export const isObjectLike = Schema.is(Schema.Union([UnknownRecord, Schema.Array(Schema.Unknown)]));
