// Original metadata identity and its current planning schema; no retired author-spelling conversions.
import { Effect, Schema } from 'effect';
import { canonical, sha256_hex } from '@norbital-ai/std/hash';
import { StoreError } from '../errors.ts';
import { SchemaSpec } from './spec.ts';

const ObjectJson = Schema.Record(Schema.String, Schema.Json);
export type SchemaSnapshot = {
	readonly fingerprint: string;
	readonly original: typeof ObjectJson.Type;
	readonly schema: SchemaSpec;
};

/** Decode current metadata without changing the object its original fingerprint identifies. */
export const schema_snapshot = Effect.fn('Store.schema_snapshot')(function* (raw: unknown): Effect.fn.Return<SchemaSnapshot, StoreError> {
	const original = yield* Schema.decodeUnknownEffect(ObjectJson)(raw).pipe(
		Effect.mapError((error) => StoreError.of('migration_invalid', 'decode', error.message, error))
	);
	const fingerprint = sha256_hex(canonical(original));
	const schema = yield* Schema.decodeUnknownEffect(SchemaSpec, { onExcessProperty: 'error' })(original).pipe(
		Effect.mapError((error) => StoreError.of('migration_invalid', 'decode', error.message, error))
	);
	return { fingerprint, original, schema };
});
