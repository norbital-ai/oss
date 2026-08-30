import { Schema } from 'effect';
import { and, arrayContains, eq, isNull, or, sql, type SQL, type SQLChunk } from 'drizzle-orm';
import { SYSTEM_MODEL_TABLES } from '#lib/authoring/system-models.js';
import { composer, jsonb } from '#lib/runtime/persistence.js';

export type RowPredicate = Readonly<{
	readonly allowed: boolean;
	readonly reason: string;
	/** Canonical policy syntax, independent of any SQL driver's placeholder numbering. */
	readonly expression: RowPredicateExpression;
	/** Whether this row set is bound to the authenticated actor rather than only shared authority. */
	readonly actorBound: boolean;
	readonly fields?: ReadonlyArray<string> | undefined;
	readonly authorization?: Schema.Json | undefined;
	readonly approval?: Schema.Json | undefined;
}>;

type RowPredicateValue = Readonly<{
	readonly kind: 'value';
	readonly value: Schema.Json;
}>;

type RowPredicateSqlText = Readonly<{
	readonly kind: 'text';
	readonly value: string;
}>;

/** An authored `policySql` scope after identity interpolation has been separated from SQL text. */
export type RowPredicateSqlPart = RowPredicateSqlText | RowPredicateValue;

export type RowPredicateExpression =
	| Readonly<{ readonly kind: 'constant'; readonly value: boolean }>
	| Readonly<{
			readonly kind: 'comparison';
			readonly column: string;
			readonly operator:
				| 'eq'
				| 'ne'
				| 'gt'
				| 'gte'
				| 'lt'
				| 'lte'
				| 'like'
				| 'ilike'
				| 'notLike'
				| 'notIlike'
				| 'arrayContains'
				| 'arrayContained'
				| 'arrayOverlaps'
				| 'contains';
			readonly value: Schema.Json;
			readonly encoding?: 'jsonb';
	  }>
	| Readonly<{
			readonly kind: 'membership';
			readonly column: string;
			readonly negated: boolean;
			readonly values: ReadonlyArray<Schema.Json>;
			readonly encoding?: 'jsonb';
	  }>
	| Readonly<{
			readonly kind: 'null';
			readonly column: string;
			readonly negated: boolean;
	  }>
	| Readonly<{
			readonly kind: 'contains-date';
			readonly column: string;
			readonly value: Schema.Json;
	  }>
	| Readonly<{
			readonly kind: 'overlaps';
			readonly column: string;
			readonly start: Schema.Json;
			readonly end: Schema.Json;
	  }>
	| Readonly<{
			readonly kind: 'and' | 'or';
			readonly expressions: ReadonlyArray<RowPredicateExpression>;
	  }>
	| Readonly<{ readonly kind: 'not'; readonly expression: RowPredicateExpression }>
	| Readonly<{
			readonly kind: 'trusted-sql';
			readonly parts: ReadonlyArray<RowPredicateSqlPart>;
	  }>
	| Readonly<{
			readonly kind: 'approval-read';
			readonly resource: string;
			readonly team: string;
	  }>;

const quoteIdentifier = (value: string): SQL => sql.raw(`"${value.replaceAll('"', '""')}"`);

const predicateColumn = (column: string, qualifier?: string): SQL =>
	qualifier === undefined
		? quoteIdentifier(column)
		: sql`${quoteIdentifier(qualifier)}.${quoteIdentifier(column)}`;

export const comparisonSql = {
	eq: '=',
	ne: '<>',
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<=',
	like: 'like',
	ilike: 'ilike',
	notLike: 'not like',
	notIlike: 'not ilike',
	arrayContains: '@>',
	arrayContained: '<@',
	arrayOverlaps: '&&',
	contains: '@>'
} as const;

const predicateValue = (value: Schema.Json, encoding?: 'jsonb'): SQL =>
	encoding === 'jsonb' ? sql`${JSON.stringify(value)}::jsonb` : sql`${value}`;

const compileExpression = (expression: RowPredicateExpression, qualifier?: string): SQL => {
	switch (expression.kind) {
		case 'constant':
			return sql.raw(expression.value ? 'true' : 'false');
		case 'comparison':
			return sql`${predicateColumn(expression.column, qualifier)} ${sql.raw(comparisonSql[expression.operator])} ${predicateValue(expression.value, expression.encoding)}`;
		case 'membership': {
			if (expression.values.length === 0) return sql.raw(expression.negated ? 'true' : 'false');
			return sql`${predicateColumn(expression.column, qualifier)} ${sql.raw(expression.negated ? 'not in' : 'in')} (${sql.join(
				expression.values.map((value) => predicateValue(value, expression.encoding)),
				sql`, `
			)})`;
		}
		case 'null':
			return sql`${predicateColumn(expression.column, qualifier)} is ${sql.raw(expression.negated ? 'not ' : '')}null`;
		case 'contains-date': {
			const column = predicateColumn(expression.column, qualifier);
			return sql`((${column}->>'start')::timestamptz <= ${expression.value} and (${column}->>'end' is null or (${column}->>'end')::timestamptz >= ${expression.value}))`;
		}
		case 'overlaps': {
			const column = predicateColumn(expression.column, qualifier);
			return sql`((${column}->>'start')::timestamptz <= ${expression.end} and ${expression.start}::timestamptz <= coalesce((${column}->>'end')::timestamptz, 'infinity'::timestamptz))`;
		}
		case 'and':
		case 'or': {
			if (expression.expressions.length === 0)
				return sql.raw(expression.kind === 'and' ? 'true' : 'false');
			if (expression.expressions.length === 1)
				return compileExpression(expression.expressions[0]!, qualifier);
			return sql`(${sql.join(
				expression.expressions.map((entry) => compileExpression(entry, qualifier)),
				sql.raw(` ${expression.kind} `)
			)})`;
		}
		case 'not':
			return sql`not (${compileExpression(expression.expression, qualifier)})`;
		case 'trusted-sql': {
			const chunks: Array<SQLChunk> = expression.parts.map((part) =>
				part.kind === 'text' ? sql.raw(part.value) : sql.param(part.value)
			);
			return sql.join(chunks);
		}
		case 'approval-read': {
			const { approval_request: approvalRequest } = SYSTEM_MODEL_TABLES;
			const query = composer
				.select({ recordId: approvalRequest.record_id })
				.from(approvalRequest)
				.where(
					and(
						eq(approvalRequest.collection_name, expression.resource),
						isNull(approvalRequest.closed_at),
						or(
							arrayContains(approvalRequest.approver_teams, jsonb([expression.team])),
							arrayContains(approvalRequest.superseder_teams, jsonb([expression.team]))
						)
					)
				);
			return sql`${predicateColumn('id', qualifier)}::text in (${query})`;
		}
	}
};

/** Compiles a policy predicate as a composable Drizzle expression with driver-owned bindings. */
export const predicateExpression = (
	predicate: RowPredicate,
	options?: Readonly<{ readonly qualifier?: string }>
): SQL => compileExpression(predicate.expression, options?.qualifier);

/** Whether a write predicate structurally admits every row, without rendering SQL to inspect it. */
export const predicateIsUnrestricted = (predicate: RowPredicate): boolean =>
	predicate.expression.kind === 'constant' && predicate.expression.value;

type RowPredicateStatement = Readonly<{
	readonly sql: string;
	readonly parameters: ReadonlyArray<Schema.Json>;
}>;

/** Serializes a predicate for a facility statement while retaining driver-owned bindings. */
export const predicateStatement = (
	predicate: RowPredicate,
	options?: Readonly<{
		readonly qualifier?: string;
		readonly parameterOffset?: number;
	}>
): RowPredicateStatement => {
	const parameterOffset = options?.parameterOffset ?? 0;
	const qualifier = options?.qualifier;
	const rendered = predicateExpression(
		predicate,
		qualifier === undefined ? undefined : { qualifier }
	)
		.getSQL()
		.toQuery({
			escapeName: (name) => `"${name.replaceAll('"', '""')}"`,
			escapeParam: (index) => `$${parameterOffset + index + 1}`,
			escapeString: (value) => `'${value.replaceAll("'", "''")}'`
		});
	return {
		sql: rendered.sql,
		parameters: rendered.params as ReadonlyArray<Schema.Json>
	};
};
