import { Option, Schema } from 'effect';

/** Number or numeric string, the decode `Number(input)` was standing in for. */
export const NumberFromUnknown = Schema.Union([Schema.Number, Schema.NumberFromString]);

/**
 * Decode a wire/form value as a number. Invalid input is `NaN`, the same as `Number('x')`, so
 * existing callers that already branch on `Number.isFinite` keep their control flow.
 *
 * Declared in this file rather than a sibling: `tests/core.test.ts` imports this module as
 * TypeScript source, and Node's type stripping does not rewrite a `./number.js` specifier to the
 * `.ts` that exists. Every other source-imported module in this package is a single file.
 */
export const decodeNumber = (value: unknown): number =>
	Option.getOrElse(Schema.decodeUnknownOption(NumberFromUnknown)(value), () => Number.NaN);

/**
 * One mutation in a JSON Patch document, as `deepDiff` and the form engine's delta carry it.
 *
 * The wire shape has one schema owner so both producers and consumers agree on the op names — a
 * `move` or `copy` op drifts out of the form engine's vocabulary and back in as a misapplied diff.
 */
export const JsonPatchOperationSchema = Schema.Struct({
	op: Schema.Literals(['add', 'remove', 'replace']),
	path: Schema.String,
	value: Schema.optional(Schema.Unknown)
});

export type JsonPatchOperation = Schema.Schema.Type<typeof JsonPatchOperationSchema>;

/**
 * Parse a JSON string, returning `null` on failure.
 *
 * Returns `unknown` — callers must decode the result with an Effect Schema
 * before treating it as a concrete type. This is the
 * unvalidated boundary parse; structured validation belongs at the call site.
 */
export function safeParse(json: string): unknown {
	return Option.getOrElse(() => null)(
		Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(json)
	);
}

function pathJoin(base: string, key: string): string {
	return `${base}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

/** Keyed records, as JSON Patch addresses them by name — arrays are addressed by index instead. */
const isKeyedObject = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** One index of two arrays: dropped past the new end, appended past the old end, or diffed. */
function indexDiff(
	a: readonly unknown[],
	b: readonly unknown[],
	index: number,
	path: string
): JsonPatchOperation[] {
	if (index >= b.length) return [{ op: 'remove', path }];
	if (index >= a.length) return [{ op: 'add', path, value: b[index] }];
	return deepDiff(a[index], b[index], path);
}

function arrayDiff(a: readonly unknown[], b: readonly unknown[], basePath: string) {
	const ops: JsonPatchOperation[] = [];
	const maxLen = Math.max(a.length, b.length);
	for (let i = 0; i < maxLen; i++) {
		ops.push(...indexDiff(a, b, i, `${basePath}/${i}`));
	}
	return ops;
}

/** One key present in the old record: removed when the new record lacks it, otherwise diffed. */
function keyDiff(a: object, b: object, key: string, path: string): JsonPatchOperation[] {
	if (!(key in b)) return [{ op: 'remove', path }];
	return deepDiff(Reflect.get(a, key), Reflect.get(b, key), path);
}

function objectDiff(a: object, b: object, basePath: string) {
	const ops: JsonPatchOperation[] = [];
	const seen = new Set<string>();

	for (const key of Object.keys(a)) {
		seen.add(key);
		ops.push(...keyDiff(a, b, key, pathJoin(basePath, key)));
	}

	for (const key of Object.keys(b)) {
		if (!seen.has(key)) {
			ops.push({ op: 'add', path: pathJoin(basePath, key), value: Reflect.get(b, key) });
		}
	}

	return ops;
}

export function deepDiff(a: unknown, b: unknown, basePath = ''): JsonPatchOperation[] {
	if (a === b) return [];
	if (Array.isArray(a) && Array.isArray(b)) return arrayDiff(a, b, basePath);
	if (isKeyedObject(a) && isKeyedObject(b)) return objectDiff(a, b, basePath);
	return [{ op: 'replace', path: basePath, value: b }];
}
