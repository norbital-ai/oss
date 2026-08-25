// repository-health:allow SEM_PARALLEL -- local-reads consumes the replica store over the #lib
// alias (#lib/client/replica/pglite-sql.js), so the pair is linked, not parallel.
import { Effect, Result, Schema } from 'effect';
import {
	compileOrderTerms,
	compileWhere,
	type WhereContext
} from '#lib/runtime/collections/where.js';
import type { LocalReplicaStore } from '#lib/client/replica/pglite-sql.js';
import { decodeReferenceRow } from '#lib/runtime/collections/references.js';

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
 *
 * The reader sends a structured operation to the replica store. Dynamic predicates still come from
 * the *server's* `compileWhere`/`compileOrderTerms` — imported, never reimplemented — but there is no
 * raw query capability here for UI or template code to call.
 */

const ReferenceTarget = Schema.Struct({
	tag: Schema.String,
	collection: Schema.String,
	storageColumn: Schema.String
});
const ReferenceDefinition = Schema.Struct({
	targets: Schema.Array(ReferenceTarget),
	onDelete: Schema.Literals(['restrict', 'cascade', 'set null'])
});
const ReplicaField = Schema.Struct({
	type: Schema.Literals(['string', 'uuid', 'number', 'boolean', 'instant', 'json', 'reference']),
	required: Schema.Boolean,
	indexed: Schema.Boolean,
	primaryKey: Schema.optionalKey(Schema.Boolean),
	unique: Schema.optionalKey(Schema.Boolean),
	generated: Schema.optionalKey(Schema.String),
	sqlType: Schema.optionalKey(Schema.String),
	sqlDefault: Schema.optionalKey(Schema.String),
	values: Schema.optionalKey(Schema.Array(Schema.String)),
	customType: Schema.optionalKey(Schema.String),
	precision: Schema.optionalKey(Schema.Literals(['day', 'minute'])),
	search: Schema.optionalKey(Schema.Boolean),
	mimeTypes: Schema.optionalKey(Schema.Array(Schema.String)),
	file: Schema.optionalKey(Schema.Boolean),
	fileMultiple: Schema.optionalKey(Schema.Boolean),
	reference: Schema.optionalKey(ReferenceDefinition)
});
const RelationEndpoint = Schema.Struct({ collection: Schema.String, column: Schema.String });
const ReplicaRelation = Schema.Struct({
	name: Schema.String,
	source: Schema.String,
	target: Schema.String,
	cardinality: Schema.Literals(['one', 'many']),
	from: Schema.optionalKey(RelationEndpoint),
	to: Schema.optionalKey(RelationEndpoint),
	cascade: Schema.optionalKey(Schema.Boolean)
});

export const ReplicaShape = Schema.Struct({
	collections: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			fields: Schema.Record(Schema.String, ReplicaField)
		})
	),
	relations: Schema.Array(ReplicaRelation)
});
export interface ReplicaShape extends Schema.Schema.Type<typeof ReplicaShape> {}

export type LocalReader = Readonly<{
	/** The rows, or `undefined` when this query must go to the server. */
	readonly answer: (
		command: string,
		input: Schema.Json
	) => Effect.Effect<Schema.Json | undefined, unknown>;
}>;

const JsonObject = Schema.Record(Schema.String, Schema.Json);
const decodeJsonObject = Schema.decodeUnknownResult(JsonObject);
const LocalReadInput = Schema.Struct({
	collection: Schema.String,
	where: Schema.optionalKey(Schema.Json),
	orderBy: Schema.optionalKey(Schema.Json),
	limit: Schema.optionalKey(Schema.Number)
});
const decodeLocalReadInput = Schema.decodeUnknownResult(LocalReadInput);

/**
 * Keys that change what a read means in ways only the server implements.
 *
 * Listed as an allowlist's complement on purpose: a key added to `QueryInput` later is unknown here,
 * and the safe response to an unrecognised key is to decline the query rather than to ignore it and
 * answer a different question.
 */
const SERVED_KEYS = new Set(['collection', 'where', 'orderBy', 'limit']);

export const createLocalReader = (
	store: LocalReplicaStore,
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
		answer: Effect.fn('ReplicaReader.answer')(function* (command, input) {
			if (command !== 'collections.findMany' && command !== 'collections.count') return undefined;
			const record = decodeJsonObject(input);
			if (Result.isFailure(record)) return undefined;
			// A key this build does not know about may narrow, widen or reshape the result. Declining is
			// the only response that cannot silently answer a different question.
			if (Object.keys(record.success).some((key) => !SERVED_KEYS.has(key))) return undefined;
			const decoded = decodeLocalReadInput(record.success);
			if (Result.isFailure(decoded)) return undefined;
			const { collection, limit, orderBy, where } = decoded.success;
			if (!readable.has(collection)) return undefined;
			const context = contextFor(collection);
			if (context === undefined) return undefined;

			let filter: {
				sql: string;
				parameters: ReadonlyArray<Schema.Json>;
			} = { sql: 'true', parameters: [] };
			if (where !== undefined) {
				const compiled = compileWhere(where, context);
				// The compiler refuses an operator it cannot express rather than widening the predicate.
				// That refusal must send the query to the server, not drop the condition.
				if (Result.isFailure(compiled)) return undefined;
				filter = compiled.success;
			}

			if (command === 'collections.count') {
				return yield* store.count(collection, filter);
			}

			const terms = orderBy === undefined ? [] : compileOrderTerms(orderBy, context);
			// An ordering the compiler dropped would silently reorder the page, so an `orderBy` that
			// yields no terms is declined rather than served unordered.
			if (orderBy !== undefined && terms.length === 0) return undefined;
			const rows = yield* store.findMany({
				collection,
				filter,
				orderBy: terms,
				// One more than asked for, which is how the server decides whether a successor exists.
				...(limit === undefined ? {} : { limit: limit + 1 })
			});
			/**
			 * A page with a successor is handed back to the server.
			 *
			 * The server's `nextCursor` is a keyset token encoding the ordering tuple the page ended on,
			 * and re-deriving it here would be the second-opinion problem again — a token that decodes
			 * but seeks to the wrong row produces a page that silently skips records. Declining means the
			 * only cursor a caller ever receives is one the server minted, and a locally served answer is
			 * always a complete result whose honest `nextCursor` is `null`.
			 */
			if (limit !== undefined && rows.length > limit) return undefined;
			return {
				rows: rows.map((record) => {
					const stored = decodeJsonObject(record);
					return Result.isSuccess(stored)
						? decodeReferenceRow(stored.success, context.fields)
						: record;
				}),
				nextCursor: null
			};
		})
	};
};
