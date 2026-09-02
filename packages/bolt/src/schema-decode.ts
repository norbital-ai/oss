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
