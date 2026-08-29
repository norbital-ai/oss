import { drizzle } from 'drizzle-orm/pg-proxy';
import {
	sql,
	type AnyDBQueryConfig,
	type AnyRelations,
	type SQL,
	type SQLChunk,
	type SQLWrapper
} from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import type { EffectId } from '@norbital-ai/bolt-protocol';
import type * as Database from '#lib/runtime/facilities/database.js';

/** A statement composed by Drizzle and ready for the host database facility. */
export type Statement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

/** The common shape exposed by every Drizzle query builder's `toSQL()` result. */
type DrizzleStatement = Readonly<{
	readonly sql: string;
	readonly params: ReadonlyArray<unknown>;
}>;

/** The common shape exposed by a Drizzle query builder before it is rendered. */
type BuiltQuery = Readonly<{ readonly toSQL: () => DrizzleStatement }>;

const TRANSACTION_STATEMENT = Symbol('@norbital-ai/bolt/TransactionStatement');

/** Raw SQL whose type makes its only legal execution path an explicit database transaction. */
type TransactionStatement = Statement & Readonly<{ readonly [TRANSACTION_STATEMENT]: true }>;

/**
 * Composes statements; it never owns a connection and never executes them.
 *
 * Bolt is a stateless bundle, so all persistence still crosses the host's database facility. The
 * proxy driver gives runtime services Drizzle's typed builders without creating a second database
 * path. Calling a query directly is therefore a defect; callers render it with `toStatement` or
 * hand it to `executeBuilt`.
 */
const refuseExecution = () =>
	Effect.runPromise(
		Effect.die(
			new Error('bolt persistence: queries are composed here and executed by the facility')
		)
	);

export const composer = drizzle(refuseExecution);

/**
 * The same composer, told which relationships this workspace has.
 *
 * Drizzle's relational query builder is only reachable through an instance that was given a
 * relations map, and the map is the workspace's — so it cannot be the module-level `composer`.
 * The driver is the identical refusal: a relational read is still composed here and executed by
 * the facility, and `db.query.x.findMany(…).toSQL()` renders without touching it.
 */
export const relationalComposer = (relations: AnyRelations) =>
	drizzle(refuseExecution, { relations });

/**
 * One collection's relational query builder, as the relational composer exposes it.
 *
 * Narrowed to the two things a composer can do with it: take a query config, and render. Drizzle's
 * own builder type is generic over the workspace's relations, which are only known at run time.
 */
export type RelationalBuilder = Readonly<{
	readonly findMany: (config?: AnyDBQueryConfig) => Readonly<{
		readonly toSQL: () => DrizzleStatement;
	}>;
}>;

/** One fixed database expression, assembled only inside this closed persistence vocabulary. */
const expression = <T>(chunks: ReadonlyArray<SQLChunk>): SQL<T> =>
	sql.join([...chunks], sql.empty()) as SQL<T>;
const fixed = (value: string): SQL => sql.raw(value);

/** A bound scalar expression; unlike a tagged SQL template it cannot carry authored syntax. */
export const bound = <T>(value: T): SQL<T> => expression([sql.param(value)]);

/** Gives a selected expression its protocol-facing name without a handwritten SQL fragment. */
export const aliased = <T>(value: SQLWrapper<T>, name: string): SQL.Aliased<T> =>
	value.getSQL().as(name);

/** The database clock used by durable ordering and lease decisions. */
export const dbNow = (): SQL<string> => expression([fixed('now()')]);

/** The schema selected by the current database connection. */
export const currentSchema = (): SQL<string> => expression([fixed('current_schema()')]);

/** Adds a bound number to a numeric column atomically. */
export const increment = (value: SQLWrapper, by = 1): SQL<number> =>
	expression([value, fixed(' + '), sql.param(by)]);

/** Moves the database clock by a bound number of seconds. */
export const dbNowPlusSeconds = (seconds: number): SQL<string> =>
	expression([fixed('now() + make_interval(secs => '), sql.param(seconds), fixed(')')]);

/** Moves the database clock backwards by a bound number of days. */
export const dbNowMinusDays = (days: number): SQL<string> =>
	expression([fixed('now() - make_interval(days => '), sql.param(days), fixed(')')]);

/** A typed `true` predicate for a builder branch that intentionally matches every row. */
export const always = (): SQL<boolean> => expression([fixed('true')]);

/**
 * A typed `false` predicate for a builder branch that intentionally matches no row.
 *
 * The fail-closed half of `always`, and it exists so an unreachable branch of a *visibility*
 * expression has somewhere safe to go: the alternative is a nullable predicate, and the obvious
 * fallback for one of those is `true`.
 */
export const nothing = (): SQL<boolean> => expression([fixed('false')]);

/** A typed constant used only as an EXISTS/RETURNING projection. */
export const one = (): SQL<number> => expression([fixed('1')]);

/** Refers to the value proposed by an `ON CONFLICT` insert. */
export const excluded = <T extends SQLWrapper>(column: T): SQL =>
	expression([
		sql.identifier('excluded'),
		fixed('.'),
		sql.identifier(String(Reflect.get(column, 'name')))
	]);

/** Preserves a column unless the proposed discriminator differs. */
export const excludedWhenDistinct = <T>(discriminator: SQLWrapper, value: SQLWrapper<T>): SQL<T> =>
	expression([
		fixed('case when '),
		discriminator,
		fixed(' is distinct from '),
		excluded(discriminator),
		fixed(' then '),
		excluded(value),
		fixed(' else '),
		value,
		fixed(' end')
	]);

/** The task lifecycle's public next-run projection. */
export const pendingNextRun = (status: SQLWrapper, runAt: SQLWrapper): SQL<string | null> =>
	expression([
		fixed('case when '),
		status,
		fixed(" in ('pending', 'resuming') then "),
		runAt,
		fixed(' else null end')
	]);

/** The resume fence keeps a still-live lease and otherwise makes the same row due now. */
export const resumedRunAt = (
	attempts: SQLWrapper,
	error: SQLWrapper,
	runAt: SQLWrapper
): SQL<string> =>
	expression([
		fixed('case when '),
		attempts,
		fixed(' > 0 and '),
		error,
		fixed(' is null and '),
		runAt,
		fixed(' > now() then '),
		runAt,
		fixed(' else now() end')
	]);

/** PostgreSQL's oldest transaction that may still be in flight. */
export const commitHorizon = (): SQL<number> =>
	expression([fixed('pg_snapshot_xmin(pg_current_snapshot())::text::bigint')]);

/** Supplies a fallback for an aggregate that found no rows. */
export const coalesce = <T>(value: SQLWrapper<T>, fallback: T): SQL<T> =>
	expression([fixed('coalesce('), value, fixed(', '), sql.param(fallback), fixed(')')]);

/** Encodes a sync cursor in the public JSON wire shape. */
export const syncCursorJson = (xid: SQLWrapper, sequence: SQLWrapper): SQL<Schema.Json> =>
	expression([
		fixed("jsonb_build_object('xid', "),
		xid,
		fixed(", 'sequence', "),
		sequence,
		fixed(')')
	]);

/** A qualified dynamic column whose identifiers remain builder-escaped. */
export const qualified = (tableAlias: string, column: string): SQL =>
	expression([sql.identifier(tableAlias), fixed('.'), sql.identifier(column)]);

/** A dynamically named table with a fixed builder-escaped alias. */
export const dynamicTable = (table: string, tableAlias: string): SQL =>
	expression([sql.identifier(table), fixed(' as '), sql.identifier(tableAlias)]);

/**
 * Rehydrates one captured JSON row as its declared PostgreSQL composite type.
 *
 * Sync uses this as a one-row FROM source so the exact compiled access predicate can be evaluated
 * independently against an outbox row's before and after images. Both table and alias are
 * builder-escaped identifiers; the image remains an expression supplied by the typed outbox table.
 */
export const jsonRecord = (table: string, image: SQLWrapper, tableAlias: string): SQL =>
	expression([
		fixed('jsonb_populate_record(null::'),
		sql.identifier(table),
		fixed(', '),
		image,
		fixed(') as '),
		sql.identifier(tableAlias)
	]);

/** Compares a UUID primary key after an optional snapshot cursor. */
export const uuidAfter = (column: SQLWrapper, value: string): SQL<boolean> =>
	expression([column, fixed(' > '), sql.param(value), fixed('::uuid')]);

/** Casts an identifier to text for policy correlation or protocol projection. */
export const asText = (value: SQLWrapper): SQL<string> => expression([value, fixed('::text')]);

/** Converts the dynamically selected snapshot row to one JSON object. */
export const rowJson = (tableAlias: string): SQL<Schema.Json> =>
	expression([fixed('to_jsonb('), sql.identifier(tableAlias), fixed(')')]);

/**
 * The pgvector distance between a vector column and a probe, as an orderable expression.
 *
 * The probe is bound as one parameter and cast, never interpolated: a driver binds a JavaScript
 * array as a Postgres *array*, which `vector` is not, so the literal text form cast to `::vector`
 * is what pgvector parses. Ordering by this expression is what lets an HNSW index answer the
 * query — a distance computed in the client cannot use the index at all.
 */
export const vectorDistance = (
	column: SQLWrapper,
	operator: '<->' | '<#>' | '<=>',
	probe: ReadonlyArray<number>
): SQL<number> =>
	expression([
		fixed('('),
		column,
		fixed(` ${operator} `),
		sql.param(JSON.stringify(probe)),
		fixed('::vector)')
	]);

/** Compares two expressions without exposing a tagged SQL template at the caller. */
export const lessThanOrEqual = <T>(left: SQLWrapper<T>, right: T): SQL<boolean> =>
	expression([left, fixed(' <= '), sql.param(right)]);

/** Reads a JSON object's text field and compares it to a bound value. */
export const jsonTextEquals = (column: SQLWrapper, key: string, value: string): SQL<boolean> =>
	expression([column, fixed('->>'), sql.param(key), fixed(' = '), sql.param(value)]);

/** Binds already-encoded JSON text as a JSONB expression. */
export const jsonb = (value: Schema.Json): SQL<Schema.Json> =>
	expression([sql.param(JSON.stringify(value)), fixed('::jsonb')]);

/** Whether a JSONB string array contains at least one member of a closed caller-supplied set. */
export const jsonArrayContainsAny = (
	column: SQLWrapper,
	values: ReadonlyArray<string>
): SQL<boolean> =>
	values.length === 0
		? nothing()
		: expression([
				column,
				fixed(' ?| array['),
				sql.join(
					values.map((value) => sql.param(value)),
					fixed(', ')
				),
				fixed(']::text[]')
			]);

/** Approximate uncompressed bytes one retained sync event would cost to replay over the wire. */
export const syncReplayEventBytes = (
	before: SQLWrapper,
	after: SQLWrapper,
	invalidatedCollections: SQLWrapper
): SQL<number> =>
	expression([
		// `pg_column_size(jsonb)` measures PostgreSQL's stored/TOAST representation. The client compares
		// this value with uncompressed replica bytes, so using the stored size systematically favours
		// replay. Text length is the comparable bounded wire-size estimate for all three JSON values.
		fixed('(coalesce(octet_length(cast('),
		before,
		fixed(' as text)), 0) + coalesce(octet_length(cast('),
		after,
		fixed(' as text)), 0) + coalesce(octet_length(cast('),
		invalidatedCollections,
		// Cursor, operation, collection, record id, row version and JSON envelope overhead.
		fixed(' as text)), 0) + 192)')
	]);

/** Sums an integer cost expression, returning zero rather than null for an empty history range. */
export const sumInteger = (value: SQLWrapper): SQL<number> =>
	expression([fixed('coalesce(sum('), value, fixed('), 0)::bigint')]);

/** Lexicographically keeps the largest durable cursor value. */
export const greatest = <T>(left: SQLWrapper<T>, right: SQLWrapper): SQL<T> =>
	expression([fixed('greatest('), left, fixed(', '), right, fixed(')')]);

/** Advances the sync sequence with the xid, never moving either component backwards. */
export const horizonSequence = (
	xid: SQLWrapper,
	sequence: SQLWrapper,
	nextXid: SQLWrapper,
	nextSequence: SQLWrapper
): SQL<number> =>
	expression([
		fixed('case when '),
		nextXid,
		fixed(' > '),
		xid,
		fixed(' then '),
		nextSequence,
		fixed(' else greatest('),
		sequence,
		fixed(', '),
		nextSequence,
		fixed(') end')
	]);

/**
 * A subquery standing where a single value is expected.
 *
 * Drizzle renders a select builder without enclosing parentheses, so a subquery spliced into an
 * expression is a syntax error until something adds them. Naming that here keeps the parentheses off
 * the callers, where one omission produces SQL that fails only at execution time.
 */
export const scalar = (query: SQLWrapper): SQL => expression([fixed('('), query, fixed(')')]);

/** The value where the condition holds, and null everywhere else. */
export const onlyWhen = <T>(condition: SQLWrapper, value: SQLWrapper<T>): SQL<T | null> =>
	expression([fixed('case when '), condition, fixed(' then '), value, fixed(' end')]);

/** Chooses the earliest non-null result of two scalar queries. */
export const least = <T>(left: SQLWrapper<T>, right: SQLWrapper<T>): SQL<T> =>
	expression([fixed('least('), left, fixed(', '), right, fixed(')')]);

/** A one-row source for selecting over scalar subqueries without owning a real table. */
export const singleton = (): SQL =>
	expression([fixed('(values (1)) as '), sql.identifier('singleton')]);

/** Brands custom SQL at construction so it can never enter the single-query execution path. */
export const transactionSql = (
	statement: string,
	parameters: ReadonlyArray<Schema.Json> = []
): TransactionStatement =>
	Object.freeze({
		sql: statement,
		parameters,
		[TRANSACTION_STATEMENT]: true as const
	});

const jsonParameter = (value: unknown): Schema.Json =>
	value instanceof Date ? value.toISOString() : Schema.decodeUnknownSync(Schema.Json)(value);

/** Converts Drizzle's driver parameters to the JSON-only facility wire. */
export const toStatement = (query: DrizzleStatement): Statement => ({
	sql: query.sql,
	parameters: query.params.map(jsonParameter)
});

/** Executes one composed query through the only database boundary Bolt owns. */
export const executeBuilt = (effectId: EffectId, database: Database.Interface, query: BuiltQuery) =>
	database.execute(effectId, { _tag: 'Query', ...toStatement(query.toSQL()) });

/** Executes a fixed group of composed statements atomically through the database facility. */
export const transactionBuilt = (
	effectId: EffectId,
	database: Database.Interface,
	queries: ReadonlyArray<BuiltQuery | TransactionStatement>
) =>
	database.execute(effectId, {
		_tag: 'Transaction',
		statements: queries.map((query) =>
			TRANSACTION_STATEMENT in query ? query : toStatement(query.toSQL())
		)
	});
