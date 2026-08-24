/**
 * Reading somebody else's JSON.
 *
 * The analyser opens a `package.json`, `tsconfig.json` or `jsconfig.json` from whatever repository
 * it is pointed at, so it cannot take a schema dependency and cannot assume a shape. It parses into
 * `unknown` and narrows from there, which is the one form the compiler keeps policing: a value
 * typed `unknown` cannot be read at all until something has proved what it is.
 *
 * That is why this file exists rather than a cast at each call site. Two readers had grown their
 * own `as Record<string, unknown>`, which is an assertion that the file on disk matches a hope.
 */

/** A JSON object, narrowed rather than asserted. Arrays are not objects for this purpose. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse text into a JSON object, or `undefined` when it is not one. */
export function readJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** A nested object field, or an empty object when the field is absent or another type. */
export function recordField(
	source: Readonly<Record<string, unknown>>,
	name: string
): Readonly<Record<string, unknown>> {
	const value = source[name];
	return isRecord(value) ? value : {};
}

/** A string field, or `undefined` when the field is absent or another type. */
export function stringField(
	source: Readonly<Record<string, unknown>>,
	name: string
): string | undefined {
	const value = source[name];
	return typeof value === 'string' ? value : undefined;
}
