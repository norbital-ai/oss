// std/json (§3.7, L-BOLT-956).
import { Result } from 'effect';

/** Parse once; a valid `null` is a success, invalid text the parser's `SyntaxError` (never a throw). */
export const parseJsonResult = (text: string): Result.Result<unknown, SyntaxError> =>
	// JSON.parse of a string throws only SyntaxError
	Result.try({ try: (): unknown => JSON.parse(text), catch: (e) => e as SyntaxError });

/** The parsed value, or null for invalid JSON (never a throw). */
export function parseJson(text: string): unknown {
	const result = parseJsonResult(text);
	return result._tag === 'Success' ? result.success : null;
}
