// Shared relation row typing stays independent of Store's mutation compiler.
import { q } from '../sql.ts';

/** A typed null from the relation itself: a table's name may also name a built-in type. */
export const null_row_sql = (table: string, columns: Iterable<string>): string => {
	const names = new Set(columns);
	let alias = '__store_row';
	while (names.has(alias)) alias += '_';
	const row = q(alias);
	return `(SELECT ${row} FROM ${q(table)} ${row} WHERE false)`;
};
