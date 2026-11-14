// How the engine composes SQL text over the wire values `@norbital-ai/host-api` parses and sends.
import { literal as quote_literal } from '@norbital-ai/store';
import { DbError, param, type Sql } from '@norbital-ai/host-api';
import type { Json } from '../../decl/values.ts';

/** Match jsonb's existing key order when a wire object is constructed outside SQL. */
export const jsonbOrder = (value: Readonly<Record<string, Json>>): Record<string, Json> =>
	Object.fromEntries(
		Object.entries(value).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
	);

export const literal = (v: Json): string => {
	const p = param(v);
	return p === null ? 'null' : quote_literal(p);
};
/** `$n` → its literal, outside quoted strings and identifiers. Needs `standard_conforming_strings` (the default). */
export const inline = (s: Sql): string =>
	s.params.length === 0 ? s.text : substituted(s, (_n, value) => literal(value));
/**
 * `s` as a fragment of a statement whose own parameters precede it: `$n` → `$(n + offset)`, its values appended
 * after them. The fragment's text stays the same per shape, so the statement's text does too.
 */
export const rebased = (s: Sql, offset: number): string =>
	s.params.length === 0 || offset === 0 ? s.text : substituted(s, (n) => `$${n + offset}`);
function substituted(s: Sql, to: (n: number, value: Json) => string): string {
	let out = '';
	for (let i = 0; i < s.text.length; i++) {
		const c = s.text.charAt(i);
		if (c === "'" || c === '"') {
			const end = s.text.indexOf(c, i + 1);
			if (end < 0) throw DbError.make('42601', 'unterminated quoted SQL');
			out += s.text.slice(i, end + 1);
			i = end;
			continue;
		}
		const m = c === '$' ? /^\$(\d+)/.exec(s.text.slice(i)) : null;
		if (m === null) {
			out += c;
			continue;
		}
		const n = Number(m[1]);
		const value = s.params[n - 1];
		if (value === undefined) throw DbError.make('08P01', `parameter $${n} has no value`);
		out += to(n, value);
		i += m[0].length - 1;
	}
	return out;
}
