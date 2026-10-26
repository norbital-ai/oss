// The store's one failure: a request it refuses itself — a literal that does not decode, a read it cannot compile, a
// schema step it will not plan. What a database answers is the executing host's to report.
import { Schema } from 'effect';

export const STORE_CODES = [
	'badCursor',
	'destructiveNotAccepted',
	'forbidden',
	'internal',
	'invalid',
	'invalidInput',
	'invalidWhere',
	'migrationChanged',
	'migrationInvalid',
	'notFound',
	'schema',
	'schemaInvalid',
	'schemaMoved',
	'stale',
	'tooLarge'
] as const;
export type StoreCode = (typeof STORE_CODES)[number];
export const STORE_PHASES = ['decode', 'admission', 'derive', 'commit', 'deliver'] as const;
export type StorePhase = (typeof STORE_PHASES)[number];

/** A request the store refuses: its `code`, the `phase` that refused it and a message naming the offending part. */
export class StoreError extends Schema.TaggedError<StoreError>()('StoreError', {
	code: Schema.Literals(STORE_CODES),
	phase: Schema.Literals(STORE_PHASES),
	message: Schema.String,
	cause: Schema.optionalKey(Schema.Defect())
}) {
	static of(code: StoreCode, phase: StorePhase, message: string, cause?: unknown): StoreError {
		return new StoreError({ code, phase, message, ...(cause === undefined ? {} : { cause }) });
	}
}
