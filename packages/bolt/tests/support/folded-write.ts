/**
 * Reading a folded write back out of the statements a harness recorded.
 *
 * A write is one statement; the rows it wrote are its `w_*` pieces. These helpers name the tables
 * a statement writes, in the order its pieces are written, so a test can still count "one insert
 * into notes" without knowing how the statement is spelled.
 */

/** Every folded write among `statements`, in order. */
export const foldedWrites = (statements: ReadonlyArray<string>): ReadonlyArray<string> =>
	statements.filter((statement) => statement.includes('anchor as materialized'));

/** The tables one folded statement writes, one entry per writing piece, in piece order. */
export const writtenTables = (statement: string): ReadonlyArray<string> =>
	[...statement.matchAll(/\bw_[a-z0-9_]+ as \((insert into|update|delete from) "([a-z_]+)"/g)].map(
		(match) => match[2]!
	);

/** The writing pieces of every folded statement that write `table`. */
export const writesTo = (statements: ReadonlyArray<string>, table: string): ReadonlyArray<string> =>
	foldedWrites(statements).flatMap((statement) =>
		writtenTables(statement).filter((written) => written === table)
	);

/** The rows a recordset piece carries: its `$n::jsonb` parameter parsed, or the `values` tuples. */
export const pieceRowCount = (
	statement: string,
	parameters: ReadonlyArray<unknown>,
	table: string
): number => {
	const piece = new RegExp(
		`w_[a-z0-9_]+ as \\(insert into "${table}" \\([^)]*\\) select [^$]* \\$(\\d+)::jsonb\\)`
	).exec(statement);
	if (piece === null) return 0;
	const rows: unknown = JSON.parse(String(parameters[Number(piece[1]) - 1]));
	return Array.isArray(rows) ? rows.length : 0;
};
