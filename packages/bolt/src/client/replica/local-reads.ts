import { Result, type Schema } from 'effect';
import type { FieldDefinition, RelationDefinition } from '../../authoring/workspace-schema.js';
import {
	compileOrderTerms,
	compileWhere,
	renderOrderBy,
	type WhereContext
} from '../../runtime/collections/where.js';
import type { PGliteLike } from './pglite-sql.js';

/**
 * Answering a read from the replica instead of the server.
 *
 * The replica already holds the rows — provisioned from the tenant's own migrations, filled by a
 * snapshot, kept current by the stream. Until now every read still went to the server anyway, with a
 * cache in front of it, so the local database was doing nothing but waiting to be asked.
 *
 * ## Why the server's own compiler, imported rather than reimplemented
 *
 * A second query compiler would be a second opinion about what `{ status: { in: [...] } }` means, and
 * the two would agree right up until they did not. The failure would be a page showing subtly
 * different rows depending on whether the replica happened to be up — the worst kind of bug, because
 * it looks like flakiness rather than like a defect. `compileWhere` and `compileOrderTerms` are pure
 * and already exported, so the local path runs the *same* code and produces the *same* SQL.
 *
 * The field metadata comes from `sync.provisioning` for the same reason: derived on the server,
 * shipped, not re-inferred here.
 *
 * ## Why it refuses so much
 *
 * `answer` returns `undefined` for anything it cannot serve *identically*, and the caller goes to the
 * server. That is the whole safety argument. Relationship expansion, free-text search, aggregates and
 * history all involve behaviour that lives in the Collections service rather than in the compiler, so
 * they are not attempted — a local answer that is merely close is worse than a remote answer that is
 * correct, and the replica exists to make reads fast, never to change them.
 */

export type ReplicaShape = Readonly<{
	readonly collections: ReadonlyArray<{
		readonly name: string;
		readonly fields: Readonly<Record<string, FieldDefinition>>;
	}>;
	readonly relations: ReadonlyArray<RelationDefinition>;
}>;

export type LocalReader = Readonly<{
	/** The rows, or `undefined` when this query must go to the server. */
	readonly answer: (command: string, input: Schema.Json) => Promise<Schema.Json | undefined>;
}>;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
	value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;

/**
 * Keys that change what a read means in ways only the server implements.
 *
 * Listed as an allowlist's complement on purpose: a key added to `QueryInput` later is unknown here,
 * and the safe response to an unrecognised key is to decline the query rather than to ignore it and
 * answer a different question.
 */
const SERVED_KEYS = new Set(['collection', 'where', 'orderBy', 'limit']);

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const createLocalReader = (
	database: PGliteLike,
	shape: ReplicaShape,
	/** Collections the subject may read; anything outside it is never answered locally. */
	readable: ReadonlySet<string>
): LocalReader => {
	const fieldsByCollection = Object.fromEntries(
		shape.collections.map((entry) => [entry.name, entry.fields])
	);
	const contextFor = (collection: string): WhereContext | undefined => {
		const fields = fieldsByCollection[collection];
		if (fields === undefined) return undefined;
		return {
			collection,
			fields,
			relations: shape.relations,
			collections: shape.collections.map(({ name }) => name),
			fieldsByCollection
		};
	};

	return {
		answer: async (command, input) => {
			if (command !== 'collections.findMany' && command !== 'collections.count') return undefined;
			const record = asRecord(input);
			if (record === undefined) return undefined;
			const collection = record['collection'];
			if (typeof collection !== 'string' || !readable.has(collection)) return undefined;
			// A key this build does not know about may narrow, widen or reshape the result. Declining is
			// the only response that cannot silently answer a different question.
			if (Object.keys(record).some((key) => !SERVED_KEYS.has(key))) return undefined;
			const context = contextFor(collection);
			if (context === undefined) return undefined;

			const where = record['where'];
			let filter = { sql: 'true', parameters: [] as ReadonlyArray<Schema.Json> };
			if (where !== undefined) {
				const compiled = compileWhere(where, context);
				// The compiler refuses an operator it cannot express rather than widening the predicate.
				// That refusal must send the query to the server, not drop the condition.
				if (Result.isFailure(compiled)) return undefined;
				filter = compiled.success;
			}

			const table = quote(collection);
			if (command === 'collections.count') {
				const counted = await database.query<{ readonly count: number }>(
					`select count(*)::int as count from ${table} where ${filter.sql}`,
					[...filter.parameters]
				);
				return (counted.rows[0]?.count ?? 0) as unknown as Schema.Json;
			}

			const orderBy = record['orderBy'];
			const terms = orderBy === undefined ? [] : compileOrderTerms(orderBy, context);
			// An ordering the compiler dropped would silently reorder the page, so an `orderBy` that
			// yields no terms is declined rather than served unordered.
			if (orderBy !== undefined && terms.length === 0) return undefined;
			const ordering = terms.length === 0 ? '' : ` ${renderOrderBy(terms)}`;

			const limit = record['limit'];
			if (limit !== undefined && typeof limit !== 'number') return undefined;
			const parameters = [...filter.parameters];
			let bounds = '';
			if (typeof limit === 'number') {
				// One more than asked for, which is how the server decides whether a successor exists.
				parameters.push((limit + 1) as unknown as Schema.Json);
				bounds = ` limit $${parameters.length}`;
			}

			// No alias: `compileWhere` qualifies columns with the collection's real table name, so
			// renaming the relation here puts its predicate out of scope.
			const result = await database.query<Readonly<Record<string, unknown>>>(
				`select to_jsonb(${table}) as record from ${table} where ${filter.sql}${ordering}${bounds}`,
				parameters
			);
			/**
			 * A page with a successor is handed back to the server.
			 *
			 * The server's `nextCursor` is a keyset token encoding the ordering tuple the page ended on,
			 * and re-deriving it here would be the second-opinion problem again — a token that decodes
			 * but seeks to the wrong row produces a page that silently skips records. Declining means the
			 * only cursor a caller ever receives is one the server minted, and a locally served answer is
			 * always a complete result whose honest `nextCursor` is `null`.
			 */
			if (typeof limit === 'number' && result.rows.length > limit) return undefined;
			return {
				rows: result.rows.map((row) => row['record']),
				nextCursor: null
			} as unknown as Schema.Json;
		}
	};
};
