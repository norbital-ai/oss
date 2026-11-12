// std/json.
import { Predicate, Result } from 'effect';
import { Decimal } from './decimal.ts';

/** Parse once; a valid `null` is a success, invalid text the parser's `SyntaxError` (never a throw). */
export const parse_json_result = (text: string): Result.Result<unknown, SyntaxError> =>
	Result.try({
		try: (): unknown => JSON.parse(text),
		catch: (e) => (e instanceof SyntaxError ? e : new SyntaxError(String(e)))
	});

/** The parsed value, or null for invalid JSON (never a throw). */
export function parse_json(text: string): unknown {
	return Result.getOrNull(parse_json_result(text));
}

const array = (value: unknown): value is readonly unknown[] => Array.isArray(value);
/** Structural equality of JSON-shaped values, preserving array order and decimal text. */
export function equal_json(a: unknown, b: unknown): boolean {
	const x = a instanceof Decimal ? a.toJSON() : a;
	const y = b instanceof Decimal ? b.toJSON() : b;
	if (x === y) return true;
	if (array(x) || array(y))
		return array(x) && array(y) && x.length === y.length && x.every((value, index) => equal_json(value, y[index]));
	if (!Predicate.isReadonlyObject(x) || !Predicate.isReadonlyObject(y)) return false;
	const entries = (value: Readonly<Record<string, unknown>>) =>
		Object.entries(value).filter(([, item]) => item !== undefined);
	const left = entries(x);
	const right = new Map(entries(y));
	return left.length === right.size && left.every(([key, value]) => right.has(key) && equal_json(value, right.get(key)));
}
