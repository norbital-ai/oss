import { sql, type SQL } from 'drizzle-orm';
import { Result, Schema } from 'effect';
import { WhereCompileError, type OrderTerm } from './where.js';

/** The scalar ordering values a cursor may carry — a json column has no total SQL order. */
const CursorValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
type CursorValue = typeof CursorValueSchema.Type;
const isCursorValue = Schema.is(CursorValueSchema);

const CursorPayloadFromJson = Schema.fromJsonString(
	Schema.Struct({
		// v3: the release that removed the pinned collations. Tokens embed the collation their
		// ordering was produced under, so every v2 token is refused rather than re-read under a
		// different sort order — which would skip or repeat rows at page boundaries.
		v: Schema.Literal(3),
		order: Schema.Array(
			Schema.Struct({
				column: Schema.String,
				direction: Schema.String,
				value: CursorValueSchema
			})
		)
	})
);

const columnSql = (column: string, qualifier?: string): SQL =>
	qualifier === undefined
		? sql`${sql.identifier(column)}`
		: sql`${sql.identifier(qualifier)}.${sql.identifier(column)}`;

const CollectionCursor = {
	encodeText: (text: string): string =>
		btoa(String.fromCharCode(...new TextEncoder().encode(text)))
			.replaceAll('+', '-')
			.replaceAll('/', '_')
			.replaceAll('=', ''),
	decodeText: (token: string): Result.Result<string, unknown> =>
		Result.try(() => {
			const binary = atob(token.replaceAll('-', '+').replaceAll('_', '/'));
			return new TextDecoder().decode(
				Uint8Array.from(binary, (character) => character.charCodeAt(0))
			);
		}),
	encode: (terms: ReadonlyArray<OrderTerm>, row: Schema.Json): string | null => {
		if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
		const order: Array<OrderTerm & { readonly value: CursorValue }> = [];
		for (const term of terms) {
			const value: unknown = Reflect.get(row, term.column);
			if (!isCursorValue(value)) return null;
			order.push({ ...term, value });
		}
		return CollectionCursor.encodeText(JSON.stringify({ v: 3, order }));
	},
	decode: (
		cursor: string,
		terms: ReadonlyArray<OrderTerm>,
		collection: string
	): Result.Result<ReadonlyArray<CursorValue>, WhereCompileError> => {
		const refuse = (message: string): Result.Result<never, WhereCompileError> =>
			Result.fail(new WhereCompileError({ collection, field: 'after', message }));
		const text = CollectionCursor.decodeText(cursor);
		if (Result.isFailure(text)) return refuse('Pagination cursor is not a decodable token.');
		const parsed = Schema.decodeUnknownResult(CursorPayloadFromJson)(text.success);
		if (Result.isFailure(parsed)) return refuse('Pagination cursor is not a decodable token.');
		if (parsed.success.v !== 3)
			return refuse('Pagination cursor was issued in a different cursor format.');
		if (parsed.success.order.length !== terms.length)
			return refuse('Pagination cursor does not match the active sort.');
		const values: Array<CursorValue> = [];
		for (let index = 0; index < terms.length; index += 1) {
			const term = terms[index];
			const entry = parsed.success.order[index];
			if (
				term === undefined ||
				entry === undefined ||
				entry.column !== term.column ||
				entry.direction !== term.direction
			)
				return refuse('Pagination cursor does not match the active sort.');
			values.push(entry.value);
		}
		return Result.succeed(values);
	},
	seek: (
		terms: ReadonlyArray<OrderTerm>,
		values: ReadonlyArray<CursorValue>,
		qualifier?: string
	): SQL => {
		const branches: Array<SQL> = [];
		for (let index = 0; index < terms.length; index += 1) {
			const term = terms[index];
			if (term === undefined) continue;
			const value = values[index] ?? null;
			// Postgres' default ASC order puts null last, so nothing follows a null tuple member.
			if (term.direction === 'asc' && value === null) continue;
			const clauses: Array<SQL> = [];
			for (let prior = 0; prior < index; prior += 1) {
				const priorTerm = terms[prior];
				if (priorTerm === undefined) continue;
				const priorValue = values[prior] ?? null;
				const priorColumn = columnSql(priorTerm.column, qualifier);
				clauses.push(
					priorValue === null ? sql`${priorColumn} is null` : sql`${priorColumn} = ${priorValue}`
				);
			}
			const column = columnSql(term.column, qualifier);
			clauses.push(
				term.direction === 'asc'
					? sql`(${column} > ${value} or ${column} is null)`
					: value === null
						? sql`${column} is not null`
						: sql`${column} < ${value}`
			);
			branches.push(sql`(${sql.join(clauses, sql` and `)})`);
		}
		return branches.length === 0 ? sql`false` : sql.join(branches, sql` or `);
	}
};

/** Encodes the cursor a client sends back as `after`. */
export const encodeCollectionCursor = CollectionCursor.encode;

/** Shared v3 token decoder; SQL adapters remain free to emit their native expression shape. */
const decodeCollectionCursor = CollectionCursor.decode;

/** Resolves one page's seek as a Drizzle expression; values remain driver-bound. */
export const compileCollectionCursorSeek = (
	after: string | undefined,
	terms: ReadonlyArray<OrderTerm>,
	collection: string,
	qualifier?: string
): Result.Result<SQL, WhereCompileError> => {
	if (after === undefined) return Result.succeed(sql`true`);
	const values = decodeCollectionCursor(after, terms, collection);
	return Result.isFailure(values)
		? Result.fail(values.failure)
		: Result.succeed(CollectionCursor.seek(terms, values.success, qualifier));
};
