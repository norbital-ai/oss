import { Result, Schema } from 'effect';
import { is, sql, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type {
	FieldDefinition,
	RelationDefinition,
	WorkspaceDefinition
} from '../../authoring/workspace-schema.js';

/** Parameterized SQL produced by collection predicate or JSON where compilation. */
export type CompiledQuery = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

/** Collection metadata the where compiler needs to distinguish columns from relations. */
export type WhereContext = Readonly<{
	readonly collection: string;
	readonly fields: Readonly<Record<string, FieldDefinition>>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	readonly collections: ReadonlyArray<string>;
	readonly fieldsByCollection: Readonly<Record<string, Readonly<Record<string, FieldDefinition>>>>;
}>;

/**
 * Names the exact condition a where object failed on. A dropped operator used to compile to a
 * silently weaker predicate — `count({ where: { created_at: { gte } } })` counted the whole table —
 * so every unsupported key now fails the invocation instead of changing the answer.
 */
export class WhereCompileError extends Schema.TaggedError<WhereCompileError>()(
	'Bolt.Collections.WhereCompileError',
	{
		collection: Schema.NonEmptyString,
		field: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {}

/** A where clause compiles to SQL or names the condition it could not express. */
export type WhereResult = Result.Result<CompiledQuery, WhereCompileError>;

/**
 * Binary column comparisons. The key is the authored operator; the value is its SQL symbol. These
 * are the operators Drizzle exposed through Bolt's `where` objects, so authored workspace code keeps
 * the vocabulary it was written against.
 */
const COMPARISON_SQL = {
	eq: '=',
	ne: '<>',
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<='
} as const;

/** Pattern-match comparisons, kept separate because `not` negates the operator rather than the clause. */
const PATTERN_SQL = {
	like: 'like',
	ilike: 'ilike',
	notLike: 'not like',
	notIlike: 'not ilike'
} as const;

/** Container operators for array-typed columns. */
const ARRAY_SQL = {
	arrayContains: '@>',
	arrayContained: '<@',
	arrayOverlaps: '&&'
} as const;

/** Operators over a `dateRange()` json column, which stores `{ start, end }` instants. */
const DATE_RANGE_OPERATORS = ['contains_date', 'overlaps'] as const;

/** Membership operators, expanded to placeholder lists so no parameter is an array literal. */
const MEMBERSHIP_OPERATORS = ['in', 'notIn'] as const;

/** Null checks, which take a boolean operand rather than a value. */
const NULL_OPERATORS = ['isNull', 'isNotNull'] as const;

/** Every operator a single column condition may carry, sorted for stable diagnostics. */
export const ACCEPTED_FIELD_OPERATORS: ReadonlyArray<string> = [
	...Object.keys(COMPARISON_SQL),
	...Object.keys(PATTERN_SQL),
	...Object.keys(ARRAY_SQL),
	...DATE_RANGE_OPERATORS,
	...MEMBERSHIP_OPERATORS,
	...NULL_OPERATORS
].toSorted();

/** Owns identifier quoting, column mapping, and relation join resolution for collection where compilation. */
const WhereSql = {
	quoteIdentifier: (name: string): string => `"${name.replaceAll('"', '""')}"`,
	// `norbital_id` is the persisted primary key, so it needs no mapping. It used to be rewritten to
	// `id`, back when Bolt invented its own table shape and the public name was a generated mirror.
	mapColumn: (field: string): string => field,
	isColumn: (context: WhereContext, key: string): boolean =>
		key.startsWith('norbital_') || Object.hasOwn(context.fields, key),
	qualify: (collection: string, field: string): string =>
		`${WhereSql.quoteIdentifier(collection)}.${WhereSql.quoteIdentifier(WhereSql.mapColumn(field))}`,
	singular: (collection: string): string =>
		collection.endsWith('s') ? collection.slice(0, -1) : collection,
	/**
	 * Widens an authored operand to a bindable parameter. `Date` reaches the compiler whenever a
	 * handler computes a window in JS, and it is not `Schema.Json`; an ISO instant is what Postgres
	 * compares a `timestamptz` against, so the conversion happens here rather than at the wire edge.
	 */
	parameter: (value: unknown): Schema.Json | undefined => {
		if (value instanceof Date)
			return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
		if (typeof value === 'bigint') return value.toString();
		return Schema.is(Schema.Json)(value) ? value : undefined;
	},
	joinPredicate: (
		source: string,
		target: string,
		relation: RelationDefinition
	): string | undefined => {
		if (relation.from === undefined || relation.to === undefined) return undefined;
		const fromSql = WhereSql.qualify(relation.from.collection, relation.from.column);
		const toSql = WhereSql.qualify(relation.to.collection, relation.to.column);
		const connects =
			(relation.from.collection === source && relation.to.collection === target) ||
			(relation.from.collection === target && relation.to.collection === source);
		return connects ? `${fromSql} = ${toSql}` : undefined;
	},
	resolveRelation: (
		context: WhereContext,
		name: string
	): Readonly<{ readonly target: string; readonly join: string }> | undefined => {
		const declared = context.relations.find(
			(relation) => relation.source === context.collection && relation.name === name
		);
		const target = declared?.target;
		if (target !== undefined) {
			const join = context.relations
				.map((relation) => WhereSql.joinPredicate(context.collection, target, relation))
				.find((predicate) => predicate !== undefined);
			if (join !== undefined) return { target, join };
		}
		const singular = WhereSql.singular(context.collection);
		const suffix = `_${singular}`;
		if (!name.endsWith(suffix)) return undefined;
		const heuristicTarget = `${name.slice(0, -suffix.length)}s`;
		if (!context.collections.includes(heuristicTarget)) return undefined;
		return {
			target: heuristicTarget,
			join: `${WhereSql.qualify(heuristicTarget, `${singular}_id`)} = ${WhereSql.qualify(context.collection, 'norbital_id')}`
		};
	},
	relatedContext: (context: WhereContext, collection: string): WhereContext => ({
		collection,
		fields: context.fieldsByCollection[collection] ?? {},
		relations: context.relations,
		collections: context.collections,
		fieldsByCollection: context.fieldsByCollection
	}),
	/** Renumbers each clause's 1-based placeholders into one flat parameter list. */
	join: (
		clauses: ReadonlyArray<CompiledQuery>,
		separator: 'AND' | 'OR',
		empty: 'true' | 'false'
	): CompiledQuery => {
		if (clauses.length === 0) return { sql: empty, parameters: [] };
		const parameters: Array<Schema.Json> = [];
		const sql = clauses
			.map((clause) => {
				const offset = parameters.length;
				parameters.push(...clause.parameters);
				return clause.sql.replaceAll(
					/\$(\d+)/g,
					(_token, index: string) => `$${Number(index) + offset}`
				);
			})
			.join(` ${separator} `);
		return { sql: clauses.length === 1 ? sql : separator === 'OR' ? `(${sql})` : sql, parameters };
	}
};

/** Builds a where-compiler context from the live workspace definition and the queried collection. */
export const makeWhereContext = (
	collection: string,
	fields: Readonly<Record<string, FieldDefinition>>,
	definition: WorkspaceDefinition
): WhereContext => ({
	collection,
	fields,
	relations: definition.relations ?? [],
	collections: definition.collections.map(({ name }) => name),
	fieldsByCollection: Object.fromEntries(
		definition.collections.map((entry) => [entry.name, entry.fields])
	)
});

const failure = (context: WhereContext, field: string, message: string): WhereResult =>
	Result.fail(new WhereCompileError({ collection: context.collection, field, message }));

const operandFailure = (context: WhereContext, field: string, operator: string): WhereResult =>
	failure(
		context,
		field,
		`Operator '${operator}' received an operand that cannot be bound as a query parameter.`
	);

/** Compiles one `{ operator: operand }` pair against an already-qualified column. */
const compileOperator = (
	context: WhereContext,
	field: string,
	fieldSql: string,
	operator: string,
	operand: unknown
): WhereResult => {
	if (Object.hasOwn(COMPARISON_SQL, operator)) {
		const value = WhereSql.parameter(operand);
		if (value === undefined) return operandFailure(context, field, operator);
		return Result.succeed({
			sql: `${fieldSql} ${COMPARISON_SQL[operator as keyof typeof COMPARISON_SQL]} $1`,
			parameters: [value]
		});
	}
	if (Object.hasOwn(PATTERN_SQL, operator)) {
		if (typeof operand !== 'string') return operandFailure(context, field, operator);
		return Result.succeed({
			sql: `${fieldSql} ${PATTERN_SQL[operator as keyof typeof PATTERN_SQL]} $1`,
			parameters: [operand]
		});
	}
	if (Object.hasOwn(ARRAY_SQL, operator)) {
		const value = WhereSql.parameter(operand);
		if (value === undefined) return operandFailure(context, field, operator);
		return Result.succeed({
			sql: `${fieldSql} ${ARRAY_SQL[operator as keyof typeof ARRAY_SQL]} $1`,
			parameters: [value]
		});
	}
	if (operator === 'in' || operator === 'notIn') {
		if (!Array.isArray(operand)) return operandFailure(context, field, operator);
		// `in ()` is a syntax error, and an empty set is a constant answer in both directions.
		if (operand.length === 0)
			return Result.succeed({ sql: operator === 'in' ? 'false' : 'true', parameters: [] });
		const parameters: Array<Schema.Json> = [];
		for (const entry of operand) {
			const value = WhereSql.parameter(entry);
			if (value === undefined) return operandFailure(context, field, operator);
			parameters.push(value);
		}
		const placeholders = parameters.map((_value, index) => `$${index + 1}`).join(', ');
		return Result.succeed({
			sql: `${fieldSql} ${operator === 'in' ? 'in' : 'not in'} (${placeholders})`,
			parameters
		});
	}
	if (operator === 'isNull' || operator === 'isNotNull') {
		if (typeof operand !== 'boolean') return operandFailure(context, field, operator);
		const wantsNull = operator === 'isNull' ? operand : !operand;
		return Result.succeed({
			sql: `${fieldSql} ${wantsNull ? 'is null' : 'is not null'}`,
			parameters: []
		});
	}
	if (operator === 'contains_date') {
		const value = WhereSql.parameter(operand);
		if (value === undefined) return operandFailure(context, field, operator);
		return Result.succeed({
			sql: `(${fieldSql}->>'start')::timestamptz <= $1 AND (${fieldSql}->>'end' is null OR (${fieldSql}->>'end')::timestamptz >= $1)`,
			parameters: [value]
		});
	}
	if (operator === 'overlaps') {
		if (operand === null || typeof operand !== 'object' || Array.isArray(operand)) {
			return operandFailure(context, field, operator);
		}
		const start = WhereSql.parameter(Reflect.get(operand, 'start'));
		const end = WhereSql.parameter(Reflect.get(operand, 'end'));
		if (start === undefined || end === undefined) return operandFailure(context, field, operator);
		return Result.succeed({
			sql: `(${fieldSql}->>'start')::timestamptz <= $2 AND ($1)::timestamptz <= coalesce((${fieldSql}->>'end')::timestamptz, 'infinity'::timestamptz)`,
			parameters: [start, end]
		});
	}
	return failure(
		context,
		field,
		`No filter operator '${operator}'. Accepted operators: ${ACCEPTED_FIELD_OPERATORS.join(', ')}.`
	);
};

/** Compiles every operator in one column condition as a conjunction. */
const compileFieldCondition = (
	context: WhereContext,
	field: string,
	condition: unknown
): WhereResult => {
	if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
		return failure(context, field, 'A column condition must be an object of operators.');
	}
	const fieldSql = WhereSql.qualify(context.collection, field);
	const clauses: Array<CompiledQuery> = [];
	for (const [operator, operand] of Object.entries(condition)) {
		const compiled = compileOperator(context, field, fieldSql, operator, operand);
		if (Result.isFailure(compiled)) return compiled;
		clauses.push(compiled.success);
	}
	return Result.succeed(WhereSql.join(clauses, 'AND', 'true'));
};

/** Compiles a list of nested where objects under one structural connective. */
const compileBranches = (
	context: WhereContext,
	key: 'AND' | 'OR',
	branches: unknown
): WhereResult => {
	if (!Array.isArray(branches))
		return failure(context, key, `'${key}' requires an array of where objects.`);
	const clauses: Array<CompiledQuery> = [];
	for (const branch of branches) {
		const compiled = compileWhere(branch, context);
		if (Result.isFailure(compiled)) return compiled;
		clauses.push(compiled.success);
	}
	return Result.succeed(WhereSql.join(clauses, key, key === 'AND' ? 'true' : 'false'));
};

/** Compiles a JSON where object as the AND of its top-level entries, including relation EXISTS. */

/**
 * Renders a `RAW` where entry: an authored callback that builds a SQL fragment.
 *
 * `RAW` is a declared part of the authoring contract, not an escape hatch someone reached for — it
 * is how a workspace expresses a predicate the operator vocabulary cannot, such as a JSONB path
 * (`origin->>'kind' = 'CLAIM'`). The previous compiler dropped unrecognised keys silently, so `RAW`
 * was ignored and the query ran unfiltered, quietly returning the wrong count. Rejecting it was no
 * better. It is compiled here so the predicate the author wrote is the predicate that runs.
 *
 * The callback is given a table whose columns render as qualified identifiers, and Drizzle's own
 * `sql` tag; the fragment is then rendered through `PgDialect`, which is how generated-column
 * expressions are already rendered elsewhere in the compiler. Operands the author interpolated
 * become bound parameters — they are never pasted into the statement.
 */
const compileRaw = (
	context: WhereContext,
	build: (table: Readonly<Record<string, unknown>>, operators: { readonly sql: unknown }) => unknown
): Result.Result<CompiledQuery, WhereCompileError> => {
	// `sql.identifier` quotes what it is given as one name, so a dotted string becomes
	// `"component_entries.origin"` — a column that does not exist. `qualify` already renders the
	// two-part form the rest of the compiler emits, so the reference is built from that.
	const reference = (name: string): unknown => sql.raw(WhereSql.qualify(context.collection, name));
	const columns = Object.fromEntries(
		Object.keys(context.fields).map((name) => [name, reference(name)])
	);
	const table = new Proxy(columns, {
		get: (target, property) =>
			typeof property === 'string' && !(property in target)
				? reference(property)
				: Reflect.get(target, property)
	});

	try {
		const fragment = build(table, { sql });
		if (!is(fragment, SQL)) {
			return Result.fail(
				new WhereCompileError({
					collection: context.collection,
					field: 'RAW',
					message: 'RAW must return a sql`` fragment.'
				})
			);
		}
		const query = new PgDialect().sqlToQuery(fragment);
		const parameters = query.params.filter((value): value is Schema.Json =>
			Schema.is(Schema.Json)(value)
		);
		if (parameters.length !== query.params.length) {
			return Result.fail(
				new WhereCompileError({
					collection: context.collection,
					field: 'RAW',
					message: 'RAW bound a value that cannot cross the facility boundary.'
				})
			);
		}
		return Result.succeed({ sql: query.sql, parameters });
	} catch (cause) {
		return Result.fail(
			new WhereCompileError({
				collection: context.collection,
				field: 'RAW',
				message: `RAW failed to build: ${cause instanceof Error ? cause.message : String(cause)}`
			})
		);
	}
};

export const compileWhere = (where: unknown, context: WhereContext, offset = 0): WhereResult => {
	if (where === undefined || where === null || typeof where !== 'object' || Array.isArray(where)) {
		return Result.succeed({ sql: 'true', parameters: [] });
	}
	const clauses: Array<CompiledQuery> = [];
	for (const [key, condition] of Object.entries(where)) {
		if (key === 'AND' || key === 'OR') {
			const branches = compileBranches(context, key, condition);
			if (Result.isFailure(branches)) return branches;
			clauses.push(branches.success);
			continue;
		}
		if (key === 'NOT') {
			const inner = compileWhere(condition, context);
			if (Result.isFailure(inner)) return inner;
			clauses.push({ sql: `not (${inner.success.sql})`, parameters: inner.success.parameters });
			continue;
		}
		if (key === 'RAW') {
			if (typeof condition !== 'function') {
				return failure(context, key, 'RAW must be a function that builds a sql`` fragment.');
			}
			const raw = compileRaw(
				context,
				condition as (
					table: Readonly<Record<string, unknown>>,
					operators: { readonly sql: unknown }
				) => unknown
			);
			if (Result.isFailure(raw)) return raw;
			clauses.push(raw.success);
			continue;
		}
		if (WhereSql.isColumn(context, key)) {
			const compiled = compileFieldCondition(context, key, condition);
			if (Result.isFailure(compiled)) return compiled;
			clauses.push(compiled.success);
			continue;
		}
		if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
			return failure(
				context,
				key,
				`'${key}' is neither a column of '${context.collection}' nor a relation filter.`
			);
		}
		const resolved = WhereSql.resolveRelation(context, key);
		if (resolved === undefined) {
			return failure(
				context,
				key,
				`'${key}' is neither a column of '${context.collection}' nor a known relation.`
			);
		}
		const inner = compileWhere(condition, WhereSql.relatedContext(context, resolved.target));
		if (Result.isFailure(inner)) return inner;
		clauses.push({
			sql: `exists (select 1 from ${WhereSql.quoteIdentifier(resolved.target)} where ${resolved.join} AND (${inner.success.sql}))`,
			parameters: inner.success.parameters
		});
	}
	const combined = WhereSql.join(clauses, 'AND', 'true');
	if (offset === 0) return Result.succeed(combined);
	return Result.succeed({
		sql: combined.sql.replaceAll(
			/\$(\d+)/g,
			(_token, index: string) => `$${Number(index) + offset}`
		),
		parameters: combined.parameters
	});
};

/** One term of a compiled `order by`: the persisted column, and the direction it sorts in. */
export type OrderTerm = Readonly<{ readonly column: string; readonly direction: 'asc' | 'desc' }>;

/**
 * Compiles a whitelist `order by` over known collection columns, always ending on the primary key.
 *
 * Keyset paging seeks past the ordering tuple of a page's last row, so the order has to be total.
 * Sorting on a non-unique column — two people both called Ada — otherwise leaves the tie broken
 * arbitrarily per statement, and rows are skipped or repeated at every page boundary. `norbital_id`
 * is the persisted primary key, so appending it is what makes the tuple unique.
 */
export const compileOrderTerms = (
	orderBy: unknown,
	context: WhereContext
): ReadonlyArray<OrderTerm> => {
	const terms: Array<OrderTerm> = [];
	if (
		orderBy !== undefined &&
		orderBy !== null &&
		typeof orderBy === 'object' &&
		!Array.isArray(orderBy)
	) {
		for (const [field, direction] of Object.entries(orderBy)) {
			if (!WhereSql.isColumn(context, field)) continue;
			if (direction !== 'asc' && direction !== 'desc') continue;
			terms.push({ column: WhereSql.mapColumn(field), direction });
		}
	}
	return terms.some(({ column }) => column === 'norbital_id')
		? terms
		: [...terms, { column: 'norbital_id', direction: 'asc' }];
};

/** Renders compiled ordering terms as the ` order by ...` suffix a select carries. */
export const renderOrderBy = (terms: ReadonlyArray<OrderTerm>): string =>
	terms.length === 0
		? ''
		: ` order by ${terms.map(({ column, direction }) => `${WhereSql.quoteIdentifier(column)} ${direction}`).join(', ')}`;
