import { Option, Schema } from 'effect';

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

export function deepDiff(a: unknown, b: unknown, basePath = ''): JsonPatchOperation[] {
	if (a === b) return [];

	if (Array.isArray(a) && Array.isArray(b)) {
		const ops: JsonPatchOperation[] = [];
		const maxLen = Math.max(a.length, b.length);
		for (let i = 0; i < maxLen; i++) {
			const p = `${basePath}/${i}`;
			if (i >= b.length) {
				ops.push({ op: 'remove', path: p });
			} else if (i >= a.length) {
				ops.push({ op: 'add', path: p, value: b[i] });
			} else {
				ops.push(...deepDiff(a[i], b[i], p));
			}
		}
		return ops;
	}

	if (
		a !== null &&
		typeof a === 'object' &&
		!Array.isArray(a) &&
		b !== null &&
		typeof b === 'object' &&
		!Array.isArray(b)
	) {
		const ops: JsonPatchOperation[] = [];
		const seen = new Set<string>();

		for (const key of Object.keys(a)) {
			seen.add(key);
			if (!(key in b)) {
				ops.push({ op: 'remove', path: pathJoin(basePath, key) });
			} else {
				ops.push(...deepDiff(Reflect.get(a, key), Reflect.get(b, key), pathJoin(basePath, key)));
			}
		}

		for (const key of Object.keys(b)) {
			if (!seen.has(key)) {
				ops.push({ op: 'add', path: pathJoin(basePath, key), value: Reflect.get(b, key) });
			}
		}

		return ops;
	}

	return [{ op: 'replace', path: basePath, value: b }];
}
