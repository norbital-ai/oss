// Typed reads (H2): a statement's rows decode once, at the database boundary, by the Schema its select list names (a
// system table's from `system/rows.ts`). A row that does not decode is an engine fault, `BoltError('internal')` naming
// the Schema's table; tenant rows a caller only relays stay `Rows` (D5).
import { Effect, Option, Result, Schema, SchemaAST } from 'effect';
import type { Rows } from '../contracts.ts';
import { BoltError } from '../../protocol/errors.ts';

const malformed = (schema: Schema.Top, issue: string): BoltError =>
	BoltError.make(
		'internal',
		'decode',
		`a ${SchemaAST.resolveIdentifier(schema.ast) ?? 'database'} row is malformed: ${issue}`
	);

/** Every row of `r`, decoded. */
export function decodeRows<A>(
	schema: Schema.Decoder<A>,
	r: Rows
): Effect.Effect<readonly A[], BoltError> {
	const decode = Schema.decodeUnknownResult(schema),
		out: A[] = [];
	for (const row of r.rows) {
		const decoded = decode(row);
		if (Result.isFailure(decoded)) return Effect.fail(malformed(schema, decoded.failure.message));
		out.push(decoded.success);
	}
	return Effect.succeed(out);
}
/** The row of a statement that answers at most one. */
export const decodeOne = <A>(
	schema: Schema.Decoder<A>,
	r: Rows
): Effect.Effect<Option.Option<A>, BoltError> =>
	r.rows.length > 1
		? Effect.fail(malformed(schema, `${r.rows.length} rows where at most one was expected`))
		: Effect.map(decodeRows(schema, r), (rows) => Option.fromNullishOr(rows[0]));
/** The one column of the one row a statement answers (`select count(*) …`). */
export function decodeValue<A>(schema: Schema.Decoder<A>, r: Rows): Effect.Effect<A, BoltError> {
	const cells = r.rows.length === 1 ? Object.values(r.rows[0] ?? {}) : [];
	if (cells.length !== 1)
		return Effect.fail(malformed(schema, 'one row of one column was expected'));
	return Result.match(Schema.decodeUnknownResult(schema)(cells[0]), {
		onFailure: (e) => Effect.fail(malformed(schema, e.message)),
		onSuccess: (a) => Effect.succeed(a)
	});
}
