import { Schema } from 'effect';
import { and, arrayContains, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type {
	CollectionIndexRequirement,
	CollectionReversePath
} from '@norbital-ai/bolt-protocol/collections';
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
	/** Query-plan facts derived from the same closed tree as `expression`. */
	readonly semantics?: PredicateSemantics | undefined;
}>;

export type PredicateRoutingConstraint = Readonly<{
	readonly field: string;
	readonly values: ReadonlyArray<Schema.Json>;
}>;

export type PredicateFieldRequirement = Readonly<{
	readonly collection: string;
	readonly field: string;
	readonly purpose: 'filter' | 'join';
}>;

export type PredicateSemantics = Readonly<{
	readonly dependencies: ReadonlyArray<string>;
	readonly reversePaths: ReadonlyArray<CollectionReversePath>;
	readonly indexRequirements: ReadonlyArray<CollectionIndexRequirement>;
	readonly routing: ReadonlyArray<PredicateRoutingConstraint>;
	readonly fields: ReadonlyArray<PredicateFieldRequirement>;
	readonly subjectOperands?: ReadonlyArray<'id' | 'email' | 'team' | 'tenantId' | 'admin'>;
	readonly opaque: boolean;
}>;

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
			readonly kind: 'case-fold';
			readonly column: string;
			readonly operator: 'eq' | 'in';
			readonly values: ReadonlyArray<Schema.Json>;
	  }>
	| Readonly<{
			readonly kind: 'json-path';
			readonly column: string;
			readonly path: ReadonlyArray<string>;
			readonly valueType: 'string' | 'number' | 'boolean' | 'instant' | 'json';
			readonly transform?: 'case-fold';
			readonly operator:
				| 'eq'
				| 'ne'
				| 'gt'
				| 'gte'
				| 'lt'
				| 'lte'
				| 'in'
				| 'notIn'
				| 'isNull'
				| 'isNotNull';
			readonly values: ReadonlyArray<Schema.Json>;
	  }>
	| Readonly<{
			readonly kind: 'json-array-some';
			readonly column: string;
			readonly path: ReadonlyArray<string>;
			readonly transform?: 'case-fold';
			readonly operator: 'eq' | 'in';
			readonly values: ReadonlyArray<Schema.Json>;
			readonly alias: string;
	  }>
	| Readonly<{
			readonly kind: 'relation';
			readonly relationship: string;
			readonly segment: string;
			readonly sourceCollection: string;
			readonly sourceField: string;
			readonly targetCollection: string;
			readonly targetField: string;
			readonly alias: string;
			readonly quantifier: 'some' | 'none' | 'every';
			readonly visibility?: RowPredicateExpression;
			readonly expression: RowPredicateExpression;
	  }>
	| Readonly<{
			readonly kind: 'approval-party';
			readonly column: string;
			readonly subjectId: string;
			readonly subjectTeam: string | null;
			readonly administrator: boolean;
	  }>
	| Readonly<{
			readonly kind: 'team-scope-users';
			readonly column: string;
			readonly subjectId: string;
	  }>
	| Readonly<{
			readonly kind: 'and' | 'or';
			readonly expressions: ReadonlyArray<RowPredicateExpression>;
	  }>
	| Readonly<{ readonly kind: 'not'; readonly expression: RowPredicateExpression }>
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

const comparisonSql = {
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

/** Binds each authored JSON-path segment as text while constructing the PostgreSQL text array. */
const jsonPath = (path: ReadonlyArray<string>): SQL =>
	sql`array[${sql.join(
		path.map((segment) => sql`${segment}::text`),
		sql`, `
	)}]`;

const jsonPathValue = (
	expression: Extract<RowPredicateExpression, { readonly kind: 'json-path' }>,
	qualifier?: string
): SQL => {
	const source = predicateColumn(expression.column, qualifier);
	const path = jsonPath(expression.path);
	const text = sql`(${source} #>> ${path})`;
	const value =
		expression.valueType === 'number'
			? sql`case when ${text} ~ '^-?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' then (${text})::double precision else null end`
			: expression.valueType === 'boolean'
				? sql`case when ${text} in ('true', 'false') then (${text})::boolean else null end`
				: expression.valueType === 'json'
						? sql`(${source} #> ${path})`
						: text;
	return expression.transform === 'case-fold' ? sql`lower(${value}::text)` : value;
};

const compileExpression = (expression: RowPredicateExpression, qualifier?: string): SQL => {
	switch (expression.kind) {
		case 'constant':
			return sql.raw(expression.value ? 'true' : 'false');
		case 'comparison':
			return expression.operator === 'eq'
				? sql`${predicateColumn(expression.column, qualifier)} is not distinct from ${predicateValue(expression.value, expression.encoding)}`
				: expression.operator === 'ne'
					? sql`${predicateColumn(expression.column, qualifier)} is distinct from ${predicateValue(expression.value, expression.encoding)}`
					: sql`${predicateColumn(expression.column, qualifier)} ${sql.raw(comparisonSql[expression.operator])} ${predicateValue(expression.value, expression.encoding)}`;
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
			return sql`((${column}->>'start') is not null and (${column}->>'start') <= ${expression.value}::text and (${column}->>'end' is null or (${column}->>'end') >= ${expression.value}::text))`;
		}
		case 'overlaps': {
			const column = predicateColumn(expression.column, qualifier);
			return sql`((${column}->>'start') is not null and (${column}->>'start') <= ${expression.end}::text and ((${column}->>'end') is null or ${expression.start}::text <= (${column}->>'end')))`;
		}
		case 'case-fold': {
			const folded = sql`lower(${predicateColumn(expression.column, qualifier)}::text)`;
			if (expression.values.length === 0) return sql`false`;
			const comparisons = expression.values.map((value) => sql`${folded} = lower(${value}::text)`);
			return expression.operator === 'eq'
				? (comparisons[0] ?? sql`false`)
				: sql`(${sql.join(comparisons, sql` or `)})`;
		}
		case 'json-path': {
			const value = jsonPathValue(expression, qualifier);
			if (expression.operator === 'isNull' || expression.operator === 'isNotNull')
				return sql`${value} is ${sql.raw(expression.operator === 'isNotNull' ? 'not ' : '')}null`;
			if (expression.values.length === 0)
				return sql.raw(expression.operator === 'notIn' ? 'true' : 'false');
			const operand = (entry: Schema.Json): SQL =>
				expression.transform === 'case-fold'
					? sql`lower(${entry}::text)`
					: expression.valueType === 'json'
						? sql`${JSON.stringify(entry)}::jsonb`
						: sql`${entry}`;
			if (expression.operator === 'in' || expression.operator === 'notIn')
				return sql`${value} ${sql.raw(expression.operator === 'notIn' ? 'not in' : 'in')} (${sql.join(
					expression.values.map(operand),
					sql`, `
				)})`;
			const operator = expression.operator === 'eq'
				? 'is not distinct from'
				: expression.operator === 'ne'
					? 'is distinct from'
					: comparisonSql[expression.operator];
			return sql`${value} ${sql.raw(operator)} ${operand(expression.values[0] ?? null)}`;
		}
		case 'json-array-some': {
			const source = predicateColumn(expression.column, qualifier);
			const array =
				expression.path.length === 0 ? source : sql`(${source} #> ${jsonPath(expression.path)})`;
			if (expression.values.length === 0) return sql`false`;
			const member = sql`${sql.identifier(expression.alias)}.${sql.identifier('value')}`;
			const comparedMember =
				expression.transform === 'case-fold' ? sql`lower(${member})` : member;
			const comparisons = expression.values.map((value) =>
				expression.transform === 'case-fold'
					? sql`${comparedMember} = lower(${value}::text)`
					: sql`${comparedMember} = ${value}::text`
			);
			return sql`case when jsonb_typeof(${array}) = 'array' then exists (select 1 from jsonb_array_elements_text(${array}) as ${sql.identifier(expression.alias)}(${sql.identifier('value')}) where ${sql.join(comparisons, sql` or `)}) else false end`;
		}
		case 'relation': {
			const target = sql.identifier(expression.targetCollection);
			const alias = sql.identifier(expression.alias);
			const joined = sql`${alias}.${sql.identifier(expression.targetField)} = ${predicateColumn(expression.sourceField, qualifier)}`;
			const nested = compileExpression(expression.expression, expression.alias);
			const visibility =
				expression.visibility === undefined
					? sql`true`
					: compileExpression(expression.visibility, expression.alias);
			const tested =
				expression.quantifier === 'every' ? sql`(${nested}) is not true` : sql`(${nested})`;
			const exists = sql`exists (select 1 from ${target} as ${alias} where ${joined} and (${visibility}) and ${tested})`;
			return expression.quantifier === 'some' ? exists : sql`not (${exists})`;
		}
		case 'approval-party': {
			const request = predicateColumn(expression.column, qualifier);
			const approval = sql.identifier('approval');
			const hasSubjectTeam = expression.subjectTeam !== null;
			const teamMember = (column: 'approver_teams' | 'superseder_teams') =>
				sql`case when jsonb_typeof(${approval}.${sql.identifier(column)}) = 'array' then exists (select 1 from jsonb_array_elements_text(${approval}.${sql.identifier(column)}) as party_team(team_name) where lower(team_name) = lower(${expression.subjectTeam}::text)) else false end`;
			return sql`(${expression.administrator}::boolean is true or ${request}::text in (select party.${sql.identifier('approval_request_id')}::text from ${sql.identifier('requestor')} as party where party.${sql.identifier('user_id')}::text is not distinct from ${expression.subjectId}::text) or (${hasSubjectTeam}::boolean is true and ${request}::text in (select ${approval}.${sql.identifier('id')}::text from ${sql.identifier('approval_request')} as ${approval} where ${teamMember('approver_teams')} or ${teamMember('superseder_teams')})))`;
		}
		case 'team-scope-users': {
			const scopedUser = predicateColumn(expression.column, qualifier);
			const user = sql.identifier('user');
			const team = sql.identifier('team');
			const rootUser = sql.identifier('scope_root_user');
			const rootTeam = sql.identifier('scope_root_team');
			const descendantTeam = sql.identifier('scope_descendant_team');
			const childTeam = sql.identifier('scope_child_team');
			const member = sql.identifier('scope_member');
			return sql`${scopedUser}::text in (with recursive ${descendantTeam}(${sql.identifier('id')}) as (select ${rootTeam}.${sql.identifier('id')} from ${user} as ${rootUser} join ${team} as ${rootTeam} on ${rootTeam}.${sql.identifier('id')} = ${rootUser}.${sql.identifier('team_id')} where ${rootUser}.${sql.identifier('id')}::text = ${expression.subjectId}::text union all select ${childTeam}.${sql.identifier('id')} from ${team} as ${childTeam} join ${descendantTeam} on ${childTeam}.${sql.identifier('parent_id')} = ${descendantTeam}.${sql.identifier('id')}) select ${member}.${sql.identifier('id')}::text from ${user} as ${member} join ${descendantTeam} on ${member}.${sql.identifier('team_id')} = ${descendantTeam}.${sql.identifier('id')})`;
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
