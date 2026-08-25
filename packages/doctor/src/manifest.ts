/**
 * Reading somebody else's JSON.
 *
 * The analyser opens a `package.json`, `tsconfig.json` or `jsconfig.json` from whatever repository
 * it is pointed at, so it cannot take a schema dependency and cannot assume a shape. It parses into
 * `unknown` and decodes from there, which is the one form the compiler keeps policing: a value
 * typed `unknown` cannot be read at all until something has proved what it is.
 *
 * That is why this file exists and why the decode lives beside the parse: the shape of a manifest
 * is the manifest's own boundary, and the moment a shape check appears anywhere else it has been
 * smuggled into the call site. `decode.ts` owns the primitives; here and only here, a manifest.
 */
import { Effect } from 'effect';
import * as Result from 'effect/Result';
import * as Schema from 'effect/Schema';

/** The plain object shape every manifest is checked against, once, at the parse boundary. */
const jsonObject = Schema.Record(Schema.String, Schema.Unknown);

/** Parse text into a JSON object, or `undefined` when it is not one. */
export function readJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
	const parsed = Effect.runSync(Effect.result(
			// repository-health:allow R6b -- the parse becomes a schema decode on the next step.
			Effect.try(() => JSON.parse(text))
		));
	return Result.match(parsed, {
		onFailure: () => undefined,
		onSuccess: (value) => decodeObject(value)
	});
}

function decodeObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
	const decoded = Schema.decodeUnknownResult(jsonObject)(value);
	return Result.match(decoded, {
		onFailure: () => undefined,
		onSuccess: (record) => record
	});
}

/**
 * A JSON record read out of an already-parsed manifest value.
 *
 * This is the manifest domain's own reader — the shape check that belongs to the boundary module,
 * not to callers — and it is Schema-backed: the decode happens through Effect, and a caller that
 * asks for a record gets a record or an explicit absence.
 */
export function jsonRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return decodeObject(value);
}

/** A nested object field, or an empty object when the field is absent or another type. */
export function recordField(
	source: Readonly<Record<string, unknown>>,
	name: string
): Readonly<Record<string, unknown>> {
	return decodeObject(source[name]) ?? {};
}

/** A string field, or `undefined` when the field is absent or another type. */
export function stringField(
	source: Readonly<Record<string, unknown>>,
	name: string
): string | undefined {
	const value = source[name];
	return typeof value === 'string' ? value : undefined;
}
