import { Effect, Result, Schema } from 'effect';
import { WhereCompileError, type OrderTerm } from '#lib/runtime/collections/where.js';

type CompiledCursorFilter = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

/** The scalar ordering values a cursor may carry — a json column has no total SQL order to seek along. */
const CursorValueSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
type CursorValue = typeof CursorValueSchema.Type;
const isCursorValue = Schema.is(CursorValueSchema);

/** The json envelope a cursor token carries: the sort it was cut from and the values it ended on. */
const CursorPayloadFromJson = Schema.fromJsonString(
	Schema.Struct({
		v: Schema.Number,
		order: Schema.Array(
			Schema.Struct({
				column: Schema.String,
				direction: Schema.String,
				collation: Schema.optionalKey(Schema.Literal('C')),
				value: CursorValueSchema
			})
		)
	})
);

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/**
 * The keyset cursor shared by the authoritative server read and the browser replica read.
 *
 * A locally cut first page must produce the exact token the server would have produced: the next
 * page may run after a scope switch or replica repair, when the wire is the only available reader.
 * Keeping this codec at their common pure boundary makes that hand-off lossless instead of creating
 * a local-only cursor dialect.
 */
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
			// A masked ordering column and a non-scalar ordering value both make a seek token dishonest.
			if (!isCursorValue(value)) return null;
			order.push({ ...term, value });
		}
		return CollectionCursor.encodeText(JSON.stringify({ v: 1, order }));
	},
	decode: (
		cursor: string,
		terms: ReadonlyArray<OrderTerm>,
		collection: string
	): Result.Result<ReadonlyArray<CursorValue>, WhereCompileError> => {
		const refuse = (
			message: string
		): Result.Result<ReadonlyArray<CursorValue>, WhereCompileError> =>
			Result.fail(new WhereCompileError({ collection, field: 'after', message }));
		const text = CollectionCursor.decodeText(cursor);
		if (Result.isFailure(text)) return refuse('Pagination cursor is not a decodable token.');
		const parsed = Schema.decodeUnknownResult(CursorPayloadFromJson)(text.success);
		if (Result.isFailure(parsed)) return refuse('Pagination cursor is not a decodable token.');
		const { v, order } = parsed.success;
		if (v !== 1) return refuse('Pagination cursor was issued in a different cursor format.');
		if (order.length !== terms.length)
			return refuse('Pagination cursor does not match the active sort.');
		const values: Array<CursorValue> = [];
		for (let index = 0; index < terms.length; index += 1) {
			const term = terms[index];
			const entry = order[index];
			if (term === undefined || entry === undefined)
				return refuse('Pagination cursor does not match the active sort.');
			if (
				entry.column !== term.column ||
				entry.direction !== term.direction ||
				entry.collation !== term.collation
			)
				return refuse('Pagination cursor does not match the active sort.');
			values.push(entry.value);
		}
		return Result.succeed(values);
	},
	/** Expands a keyset tuple into the lexicographic SQL predicate for the following page. */
	seek: (
		terms: ReadonlyArray<OrderTerm>,
		values: ReadonlyArray<CursorValue>,
		parameterOffset: number
	): CompiledCursorFilter => {
		const parameters: Array<CursorValue> = [];
		const bind = (value: CursorValue): string => {
			parameters.push(value);
			return `$${parameterOffset + parameters.length}`;
		};
		const branches: Array<string> = [];
		for (let index = 0; index < terms.length; index += 1) {
			const term = terms[index];
			if (term === undefined) continue;
			const value = values[index] ?? null;
			// Nothing sorts after a null under asc; later terms still settle null ties.
			if (term.direction === 'asc' && value === null) continue;
			const clauses: Array<string> = [];
			for (let prior = 0; prior < index; prior += 1) {
				const priorTerm = terms[prior];
				if (priorTerm === undefined) continue;
				const priorValue = values[prior] ?? null;
				const priorColumn = `${quoteIdentifier(priorTerm.column)}${priorTerm.collation === undefined ? '' : ` collate "${priorTerm.collation}"`}`;
				clauses.push(
					priorValue === null ? `${priorColumn} is null` : `${priorColumn} = ${bind(priorValue)}`
				);
			}
			const column = `${quoteIdentifier(term.column)}${term.collation === undefined ? '' : ` collate "${term.collation}"`}`;
			clauses.push(
				term.direction === 'asc'
					? `(${column} > ${bind(value)} or ${column} is null)`
					: value === null
						? `${column} is not null`
						: `${column} < ${bind(value)}`
			);
			branches.push(`(${clauses.join(' and ')})`);
		}
		return { sql: branches.length === 0 ? 'false' : branches.join(' or '), parameters };
	}
};

/** Encodes the cursor a client sends back as `after`. */
export const encodeCollectionCursor = CollectionCursor.encode;

/** Resolves one page's seek predicate with placeholders rebased for its surrounding query. */
export const compileCollectionCursorSeek = (
	after: string | undefined,
	terms: ReadonlyArray<OrderTerm>,
	collection: string,
	parameterOffset = 0
): Effect.Effect<CompiledCursorFilter, WhereCompileError> => {
	if (after === undefined) return Effect.succeed({ sql: 'true', parameters: [] });
	const values = CollectionCursor.decode(after, terms, collection);
	return Result.isFailure(values)
		? Effect.fail(values.failure)
		: Effect.succeed(CollectionCursor.seek(terms, values.success, parameterOffset));
};
