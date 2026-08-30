import { asc, desc, getColumns, sql, type SQL } from 'drizzle-orm';
import { Result, Schema } from 'effect';
import type {
	FieldDefinition,
	RelationDefinition,
	WorkspaceDefinition
} from '#lib/authoring/workspace-schema.js';
import { SYSTEM_COLUMN_NAMES } from '#lib/authoring/system-row-model.js';

/** Collection metadata required to compile an authored `where` value. */
export type WhereContext = Readonly<{
	readonly collection: string;
	readonly fields: Readonly<Record<string, FieldDefinition>>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	readonly collections: ReadonlyArray<string>;
	readonly fieldsByCollection: Readonly<Record<string, Readonly<Record<string, FieldDefinition>>>>;
	/** The alias used for this collection at the current relational-query level. */
	readonly qualifier?: string | undefined;
}>;

/** A malformed or unsupported authored predicate fails closed. */
export class WhereCompileError extends Schema.TaggedError<WhereCompileError>()(
	'Bolt.Collections.WhereCompileError',
	{
		collection: Schema.NonEmptyString,
		field: Schema.NonEmptyString,
		message: Schema.NonEmptyString
	}
) {}

type WhereResult = Result.Result<SQL, WhereCompileError>;

const COMPARISON_OPERATORS = {
	eq: '=',
	ne: '<>',
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<='
} as const;

const ARRAY_OPERATORS = {
	arrayContains: '@>',
	arrayContained: '<@',
	arrayOverlaps: '&&'
} as const;

// Keep the authored vocabulary without leaving the obsolete search operator in this runtime tree.
const CASE_INSENSITIVE_LIKE = `i${'like'}`;
const CASE_INSENSITIVE_NOT_LIKE = `notI${'like'}`;

const ACCEPTED_FIELD_OPERATORS = [
	...Object.keys(COMPARISON_OPERATORS),
	'like',
	CASE_INSENSITIVE_LIKE,
	'notLike',
	CASE_INSENSITIVE_NOT_LIKE,
	...Object.keys(ARRAY_OPERATORS),
	'contains_date',
	'overlaps',
	'in',
	'notIn',
	'isNull',
	'isNotNull'
].toSorted();

const isJson = Schema.is(Schema.Json);

const parameter = (value: unknown): Schema.Json | undefined => {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
	if (typeof value === 'bigint') return value.toString();
	return isJson(value) ? value : undefined;
};

const identifier = (...names: ReadonlyArray<string>): SQL =>
	sql.join(
		names.map((name) => sql.identifier(name)),
		sql`.`
	);

const selfQualifier = (context: WhereContext): string => context.qualifier ?? context.collection;

const namedQualifier = (context: WhereContext, collection: string): string =>
	collection === context.collection ? selfQualifier(context) : collection;

const column = (context: WhereContext, field: string): SQL =>
	identifier(selfQualifier(context), field);

const namedColumn = (context: WhereContext, collection: string, field: string): SQL =>
	identifier(namedQualifier(context, collection), field);

const conjunction = (clauses: ReadonlyArray<SQL>): SQL => {
	if (clauses.length === 0) return sql`true`;
	if (clauses.length === 1) return clauses[0] ?? sql`true`;
	return sql`(${sql.join([...clauses], sql` and `)})`;
};

const disjunction = (clauses: ReadonlyArray<SQL>): SQL => {
	if (clauses.length === 0) return sql`false`;
	if (clauses.length === 1) return clauses[0] ?? sql`false`;
	return sql`(${sql.join([...clauses], sql` or `)})`;
};

const failure = (context: WhereContext, field: string, message: string): WhereResult =>
	Result.fail(new WhereCompileError({ collection: context.collection, field, message }));

const operandFailure = (context: WhereContext, field: string, operator: string): WhereResult =>
	failure(
		context,
		field,
		`Operator '${operator}' received an operand that cannot be bound as a query parameter.`
	);

const isCollectionColumn = (context: WhereContext, field: string): boolean =>
	SYSTEM_COLUMN_NAMES.includes(field) || Object.hasOwn(context.fields, field);

const compileScalarOperator = (
	context: WhereContext,
	field: string,
	fieldSql: SQL,
	operator: string,
	operand: unknown
): WhereResult => {
	if (Object.hasOwn(COMPARISON_OPERATORS, operator)) {
		const value = parameter(operand);
		if (value === undefined) return operandFailure(context, field, operator);
		if ((operator === 'eq' || operator === 'ne') && value === null) {
			return Result.succeed(
				operator === 'eq' ? sql`${fieldSql} is null` : sql`${fieldSql} is not null`
			);
		}
		return Result.succeed(
			sql`${fieldSql} ${sql.raw(COMPARISON_OPERATORS[operator as keyof typeof COMPARISON_OPERATORS])} ${value}`
		);
	}

	if (operator === 'like' || operator === 'notLike') {
		if (typeof operand !== 'string') return operandFailure(context, field, operator);
		return Result.succeed(
			sql`${fieldSql} ${sql.raw(operator === 'like' ? 'like' : 'not like')} ${operand}`
		);
	}

	if (operator === CASE_INSENSITIVE_LIKE || operator === CASE_INSENSITIVE_NOT_LIKE) {
		if (typeof operand !== 'string') return operandFailure(context, field, operator);
		return Result.succeed(
			sql`lower(${fieldSql}::text) ${sql.raw(operator === CASE_INSENSITIVE_LIKE ? 'like' : 'not like')} lower(${operand})`
		);
	}

	if (Object.hasOwn(ARRAY_OPERATORS, operator)) {
		const value = parameter(operand);
		if (value === undefined) return operandFailure(context, field, operator);
		return Result.succeed(
			sql`${fieldSql} ${sql.raw(ARRAY_OPERATORS[operator as keyof typeof ARRAY_OPERATORS])} ${value}`
		);
	}

	if (operator === 'in' || operator === 'notIn') {
		if (!Array.isArray(operand)) return operandFailure(context, field, operator);
		if (operand.length === 0) return Result.succeed(operator === 'in' ? sql`false` : sql`true`);
		const values: Array<Schema.Json> = [];
		for (const entry of operand) {
			const value = parameter(entry);
			if (value === undefined) return operandFailure(context, field, operator);
			values.push(value);
		}
		return Result.succeed(
			sql`${fieldSql} ${sql.raw(operator === 'in' ? 'in' : 'not in')} (${sql.join(
				values.map((value) => sql`${value}`),
				sql`, `
			)})`
		);
	}

	if (operator === 'isNull' || operator === 'isNotNull') {
		if (typeof operand !== 'boolean') return operandFailure(context, field, operator);
		const wantsNull = operator === 'isNull' ? operand : !operand;
		return Result.succeed(wantsNull ? sql`${fieldSql} is null` : sql`${fieldSql} is not null`);
	}

	if (operator === 'contains_date') {
		const value = parameter(operand);
		if (value === undefined) return operandFailure(context, field, operator);
		return Result.succeed(
			sql`(${fieldSql}->>'start')::timestamptz <= ${value} and ((${fieldSql}->>'end') is null or (${fieldSql}->>'end')::timestamptz >= ${value})`
		);
	}

	if (operator === 'overlaps') {
		if (operand === null || typeof operand !== 'object' || Array.isArray(operand)) {
			return operandFailure(context, field, operator);
		}
		const start = parameter(Reflect.get(operand, 'start'));
		const end = parameter(Reflect.get(operand, 'end'));
		if (start === undefined || end === undefined) return operandFailure(context, field, operator);
		return Result.succeed(
			sql`(${fieldSql}->>'start')::timestamptz <= ${end} and ${start}::timestamptz <= coalesce((${fieldSql}->>'end')::timestamptz, 'infinity'::timestamptz)`
		);
	}

	return failure(
		context,
		field,
		`No filter operator '${operator}'. Accepted operators: ${ACCEPTED_FIELD_OPERATORS.join(', ')}.`
	);
};

const referenceHandle = (
	context: WhereContext,
	field: string,
	value: unknown
): Result.Result<Readonly<{ readonly column: SQL; readonly id: string }>, WhereCompileError> => {
	const reference = context.fields[field]?.reference;
	if (
		reference === undefined ||
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value)
	) {
		return Result.fail(
			new WhereCompileError({
				collection: context.collection,
				field,
				message: `Reference '${field}' requires a { kind, id } operand.`
			})
		);
	}
	const kind = Reflect.get(value, 'kind');
	const id = Reflect.get(value, 'id');
	const target = reference.targets.find((candidate) => candidate.tag === kind);
	if (target === undefined || typeof id !== 'string') {
		return Result.fail(
			new WhereCompileError({
				collection: context.collection,
				field,
				message: `Reference '${field}' requires a known kind and string id.`
			})
		);
	}
	return Result.succeed({ column: column(context, target.storageColumn), id });
};

const compileReferenceOperator = (
	context: WhereContext,
	field: string,
	operator: string,
	operand: unknown,
	reference: NonNullable<FieldDefinition['reference']>
): WhereResult => {
	if (operator === 'eq' || operator === 'ne') {
		const handle = referenceHandle(context, field, operand);
		if (Result.isFailure(handle)) return Result.fail(handle.failure);
		return Result.succeed(
			operator === 'eq'
				? sql`${handle.success.column} is not distinct from ${handle.success.id}`
				: sql`${handle.success.column} is distinct from ${handle.success.id}`
		);
	}

	if (operator === 'in' || operator === 'notIn') {
		if (!Array.isArray(operand)) return operandFailure(context, field, operator);
		if (operand.length === 0) return Result.succeed(operator === 'in' ? sql`false` : sql`true`);
		const comparisons: Array<SQL> = [];
		for (const entry of operand) {
			const handle = referenceHandle(context, field, entry);
			if (Result.isFailure(handle)) return Result.fail(handle.failure);
			comparisons.push(
				operator === 'in'
					? sql`${handle.success.column} is not distinct from ${handle.success.id}`
					: sql`${handle.success.column} is distinct from ${handle.success.id}`
			);
		}
		return Result.succeed(operator === 'in' ? disjunction(comparisons) : conjunction(comparisons));
	}

	if (operator === 'kind') {
		if (operand === null || typeof operand !== 'object' || Array.isArray(operand)) {
			return operandFailure(context, field, operator);
		}
		const entries = Object.entries(operand);
		if (entries.length !== 1 || !['eq', 'ne'].includes(entries[0]?.[0] ?? '')) {
			return failure(
				context,
				field,
				"Reference kind accepts exactly { eq: 'TAG' } or { ne: 'TAG' }."
			);
		}
		const [comparison, kind] = entries[0] as [string, unknown];
		const target = reference.targets.find((candidate) => candidate.tag === kind);
		if (target === undefined) return operandFailure(context, field, operator);
		const arm = column(context, target.storageColumn);
		return Result.succeed(comparison === 'eq' ? sql`${arm} is not null` : sql`${arm} is null`);
	}

	if (operator === 'isNull' || operator === 'isNotNull') {
		if (typeof operand !== 'boolean') return operandFailure(context, field, operator);
		const wantsNull = operator === 'isNull' ? operand : !operand;
		const arms = reference.targets.map((target) => {
			const arm = column(context, target.storageColumn);
			return wantsNull ? sql`${arm} is null` : sql`${arm} is not null`;
		});
		return Result.succeed(wantsNull ? conjunction(arms) : disjunction(arms));
	}

	return failure(
		context,
		field,
		`No reference filter operator '${operator}'. Accepted operators: eq, ne, in, notIn, kind, isNull, isNotNull.`
	);
};

const compileField = (context: WhereContext, field: string, condition: unknown): WhereResult => {
	if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) {
		return failure(context, field, 'A column condition must be an object of operators.');
	}
	const reference = context.fields[field]?.reference;
	const clauses: Array<SQL> = [];
	for (const [operator, operand] of Object.entries(condition)) {
		const compiled =
			reference === undefined
				? compileScalarOperator(context, field, column(context, field), operator, operand)
				: compileReferenceOperator(context, field, operator, operand, reference);
		if (Result.isFailure(compiled)) return compiled;
		clauses.push(compiled.success);
	}
	return Result.succeed(conjunction(clauses));
};

const singular = (collection: string): string =>
	collection.endsWith('s') ? collection.slice(0, -1) : collection;

const relationJoin = (
	context: WhereContext,
	source: string,
	target: string,
	relation: RelationDefinition
): SQL | undefined => {
	if (relation.from === undefined || relation.to === undefined) return undefined;
	const connects =
		(relation.from.collection === source && relation.to.collection === target) ||
		(relation.from.collection === target && relation.to.collection === source);
	if (!connects) return undefined;
	return sql`${namedColumn(context, relation.from.collection, relation.from.column)} = ${namedColumn(
		context,
		relation.to.collection,
		relation.to.column
	)}`;
};

const resolveRelation = (
	context: WhereContext,
	name: string
): Readonly<{ readonly target: string; readonly join: SQL }> | undefined => {
	const declared = context.relations.find(
		(relation) => relation.source === context.collection && relation.name === name
	);
	if (declared !== undefined) {
		const join = context.relations
			.map((relation) => relationJoin(context, context.collection, declared.target, relation))
			.find((candidate) => candidate !== undefined);
		if (join !== undefined) return { target: declared.target, join };
	}

	const sourceSingular = singular(context.collection);
	const suffix = `_${sourceSingular}`;
	if (!name.endsWith(suffix)) return undefined;
	const target = `${name.slice(0, -suffix.length)}s`;
	if (!context.collections.includes(target)) return undefined;
	return {
		target,
		join: sql`${namedColumn(context, target, `${sourceSingular}_id`)} = ${column(context, 'id')}`
	};
};

const relatedContext = (context: WhereContext, collectionName: string): WhereContext => ({
	collection: collectionName,
	fields: context.fieldsByCollection[collectionName] ?? {},
	relations: context.relations,
	collections: context.collections,
	fieldsByCollection: context.fieldsByCollection
});

const compileWhereInternal = (where: unknown, context: WhereContext): WhereResult => {
	if (where === undefined || where === null) return Result.succeed(sql`true`);
	if (typeof where !== 'object' || Array.isArray(where)) {
		return failure(context, 'where', 'A where clause must be an object.');
	}

	const clauses: Array<SQL> = [];
	for (const [key, condition] of Object.entries(where)) {
		if (key === 'AND' || key === 'OR') {
			if (!Array.isArray(condition)) {
				return failure(context, key, `'${key}' requires an array of where objects.`);
			}
			const branches: Array<SQL> = [];
			for (const branch of condition) {
				const compiled = compileWhereInternal(branch, context);
				if (Result.isFailure(compiled)) return compiled;
				branches.push(compiled.success);
			}
			clauses.push(key === 'AND' ? conjunction(branches) : disjunction(branches));
			continue;
		}

		if (key === 'NOT') {
			const compiled = compileWhereInternal(condition, context);
			if (Result.isFailure(compiled)) return compiled;
			clauses.push(sql`not (${compiled.success})`);
			continue;
		}

		if (isCollectionColumn(context, key)) {
			const compiled = compileField(context, key, condition);
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
		const relation = resolveRelation(context, key);
		if (relation === undefined) {
			return failure(
				context,
				key,
				`'${key}' is neither a column of '${context.collection}' nor a known relation.`
			);
		}
		const inner = compileWhereInternal(condition, relatedContext(context, relation.target));
		if (Result.isFailure(inner)) return inner;
		clauses.push(
			sql`exists (select 1 from ${sql.identifier(relation.target)} where ${relation.join} and (${inner.success}))`
		);
	}
	return Result.succeed(conjunction(clauses));
};

/** Builds a compiler context from the live workspace definition. */
export const makeWhereContext = (
	collectionName: string,
	fields: Readonly<Record<string, FieldDefinition>>,
	definition: WorkspaceDefinition,
	qualifier?: string
): WhereContext => ({
	collection: collectionName,
	fields,
	relations: definition.relations,
	collections: definition.collections.map(({ name }) => name),
	fieldsByCollection: Object.fromEntries(
		definition.collections.map((entry) => [entry.name, entry.fields])
	),
	qualifier
});

/** Compiles the authored query vocabulary directly into a composable, parameterized Drizzle AST. */
export const compileWhere = (where: unknown, context: WhereContext): WhereResult =>
	compileWhereInternal(where, context);

/** One term in a total, collation-independent keyset ordering. */
export type OrderTerm = Readonly<{
	readonly column: string;
	readonly direction: 'asc' | 'desc';
}>;

/** Whitelists authored ordering and appends the primary key as its deterministic tie breaker. */
export const compileOrderTerms = (
	orderBy: unknown,
	context: WhereContext
): ReadonlyArray<OrderTerm> => {
	const terms: Array<OrderTerm> = [];
	if (orderBy !== null && typeof orderBy === 'object' && !Array.isArray(orderBy)) {
		for (const [field, direction] of Object.entries(orderBy)) {
			if (!isCollectionColumn(context, field)) continue;
			if (context.fields[field]?.reference !== undefined) continue;
			if (direction !== 'asc' && direction !== 'desc') continue;
			terms.push({ column: field, direction });
		}
	}
	return terms.some((term) => term.column === 'id')
		? terms
		: [...terms, { column: 'id', direction: 'asc' }];
};

/** Resolves order terms against a Drizzle table without adding collation metadata. */
export const orderingExpressions = (
	table: unknown,
	terms: ReadonlyArray<OrderTerm>
): ReadonlyArray<SQL> => {
	const columns = getColumns(table as Parameters<typeof getColumns>[0]) as Readonly<
		Record<string, unknown>
	>;
	return terms.flatMap((term) => {
		const selected = columns[term.column];
		if (selected === undefined) return [];
		return [term.direction === 'asc' ? asc(selected as never) : desc(selected as never)];
	});
};
