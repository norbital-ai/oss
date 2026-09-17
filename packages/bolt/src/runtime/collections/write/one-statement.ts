/**
 * One write, one statement.
 *
 * A tenant database is a network away and charges per statement, so everything a write consists
 * of — its guards, its deletes, updates and inserts, their history, the outbox, the approval hold,
 * the browser ledger claim and the read-back of what was written — is folded into one `WITH`
 * chain. Every piece keeps the SQL it was composed with; this module only hoists, renumbers and
 * references.
 *
 * The one rule a piece must obey: every sub-statement of a `WITH` sees the same snapshot, taken
 * when the statement begins, so a piece that must observe another piece's effect reads that piece's
 * `RETURNING` set by its name rather than the table. A guard is a `select` referenced from the
 * final query (an unreferenced `select` CTE never runs); a modifying CTE runs whether referenced or
 * not.
 */
import type { Schema } from 'effect';

export type Fragment = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

/** A piece of the write, named so that another piece may reference its `RETURNING` set. */
export type Piece = Readonly<{
	/** Stable handle; the compiled CTE name is `cteName(key)`. */
	readonly key: string;
	readonly fragment: Fragment;
}>;

/** The CTE a piece compiles to. Keys are caller-chosen identifiers; the prefix keeps them apart from hoisted names. */
export const cteName = (key: string): string => `w_${key}`;

type Split = Readonly<{
	readonly recursive: boolean;
	readonly ctes: ReadonlyArray<
		Readonly<{ readonly name: string; readonly columns: string; readonly sql: string }>
	>;
	readonly body: string;
}>;

/** Renumbers `$n` placeholders by `offset`, leaving quoted text alone. */
const shift = (sql: string, offset: number): string =>
	offset === 0
		? sql
		: sql.replace(
				/('(?:[^']|'')*'|"(?:[^"]|"")*")|\$(\d+)\b/g,
				(match, quoted: string | undefined, index: string | undefined) =>
					quoted !== undefined ? quoted : `$${Number(index) + offset}`
			);

/** The index just past the `)` that closes the `(` at `open`, honouring quoted text. */
const closingParen = (sql: string, open: number): number => {
	let depth = 0;
	for (let index = open; index < sql.length; index += 1) {
		const char = sql[index];
		if (char === "'" || char === '"') {
			const quote = char;
			index += 1;
			while (index < sql.length) {
				if (sql[index] === quote) {
					if (sql[index + 1] === quote) index += 2;
					else break;
				} else index += 1;
			}
			continue;
		}
		if (char === '(') depth += 1;
		else if (char === ')') {
			depth -= 1;
			if (depth === 0) return index + 1;
		}
	}
	throw new Error('unbalanced parentheses in a write fragment');
};

/** Splits a top-level `with [recursive] a as (…), b as (…) <body>` into its parts; a bare body has none. */
export const splitWith = (sql: string): Split => {
	const trimmed = sql.trim();
	const head = /^with\s+(recursive\s+)?/i.exec(trimmed);
	if (head === null) return { recursive: false, ctes: [], body: trimmed };
	const ctes: Array<{ name: string; columns: string; sql: string }> = [];
	let cursor = head[0].length;
	for (;;) {
		const name =
			/^\s*("?)([A-Za-z_][A-Za-z0-9_]*)\1(\s*\([^)]*\))?\s+as\s+(?:(?:not\s+)?materialized\s+)?\(/i.exec(
				trimmed.slice(cursor)
			);
		if (name === null)
			throw new Error(
				`unreadable common table expression near: ${trimmed.slice(cursor, cursor + 40)}`
			);
		const open = cursor + name[0].length - 1;
		const close = closingParen(trimmed, open);
		ctes.push({
			name: name[2]!,
			columns: name[3]?.trim() ?? '',
			sql: trimmed.slice(open + 1, close - 1)
		});
		const separator = /^\s*,/.exec(trimmed.slice(close));
		if (separator === null) {
			return { recursive: head[1] !== undefined, ctes, body: trimmed.slice(close).trim() };
		}
		cursor = close + separator[0].length;
	}
};

const isSelect = (body: string): boolean => /^\s*select\b/i.test(body);

/**
 * Folds the pieces of one write into one statement.
 *
 * `pieces` run in the one snapshot, so their order is only the order they are written in the
 * text. A `select` piece is a guard: it is referenced from the anchor so it always runs, and a
 * `bolt_assert` inside it fails the whole statement. A modifying piece runs regardless. `final`
 * is the query whose rows the statement answers with; it may reference any piece by `cteName`,
 * and must reference `anchor` (one row) so the guards run even when it answers nothing.
 */
export const oneStatement = (pieces: ReadonlyArray<Piece>, final: Fragment): Fragment => {
	const parameters: Array<Schema.Json> = [];
	const hoisted: Array<string> = [];
	const names = new Set<string>();
	const guards: Array<string> = [];
	let recursive = false;
	const claim = (name: string) => {
		if (names.has(name))
			throw new Error(`two pieces of one write hoist a common table expression named ${name}`);
		names.add(name);
	};
	const fold = (fragment: Fragment): Split => {
		const offset = parameters.length;
		parameters.push(...fragment.parameters);
		const split = splitWith(shift(fragment.sql, offset));
		recursive ||= split.recursive;
		for (const cte of split.ctes) {
			claim(cte.name);
			hoisted.push(`${cte.name}${cte.columns} as (${cte.sql})`);
		}
		return split;
	};
	for (const piece of pieces) {
		const name = cteName(piece.key);
		const split = fold(piece.fragment);
		claim(name);
		if (isSelect(split.body)) {
			hoisted.push(`${name} as materialized (${split.body})`);
			guards.push(name);
		} else hoisted.push(`${name} as (${split.body})`);
	}
	claim('anchor');
	hoisted.push(
		`anchor as materialized (select ${
			guards.length === 0
				? '0'
				: guards.map((guard) => `(select count(*) from ${guard})`).join(' + ')
		} as guarded)`
	);
	const closing = fold(final);
	return {
		sql: `with ${recursive ? 'recursive ' : ''}${hoisted.join(', ')} ${closing.body}`,
		parameters
	};
};
