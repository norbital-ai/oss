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

/** Chooses the earliest non-null result of two scalar queries. PostgreSQL ignores nulls in LEAST. */
export const least = <T>(left: SQLWrapper<T>, right: SQLWrapper<T>): SQL<T> =>
	expression([fixed('least('), left, fixed(', '), right, fixed(')')]);

/** A one-row source for selecting over scalar subqueries without owning a real table. */
export const singleton = (): SQL =>
	expression([fixed('(values (1)) as '), sql.identifier('singleton')]);

/** A typed `true` predicate for a builder branch that intentionally matches every row. */
export const always = (): SQL<boolean> => expression([fixed('true')]);

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
