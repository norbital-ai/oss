import { typeGuard } from '@norbital-ai/std/schema';
import { getColumns } from 'drizzle-orm';
import { z } from 'zod';
import type { TCollectionActionContext } from './approval_scope_types.js';
import { getWorkspace } from '$lib/server/bootstrap/workspace_store.js';
import { isUnconditionalPolicyWhere } from './policy_sql.server.js';
import { quoteSqlIdentifier } from '../sql-identifier.server.js';

const recordSchema = z.record(z.string(), z.unknown());

type TMutationActionContext = Extract<
	TCollectionActionContext,
	{ type: 'create' | 'update' | 'delete' }
>;

function mutationRecord(context: TMutationActionContext): Record<string, unknown> {
	switch (context.type) {
		case 'create':
			return context.payload;
		case 'update':
			return { ...context.scope.original_record, ...context.payload };
		case 'delete':
			return context.scope.original_record;
		default: {
			const _exhaustive: never = context;
			return _exhaustive;
		}
	}
}

function resolveScopePath(scope: Record<string, unknown>, path: string): unknown {
	let current: unknown = scope;
	for (const part of path.split('.')) {
		if (!typeGuard(recordSchema, current)) return undefined;
		current = current[part];
	}
	return current;
}

function bindScopeValue(value: unknown, scope: Record<string, unknown>): unknown {
	if (typeof value === 'string') {
		const exact = /^\$\{([^}]+)\}$/.exec(value);
		if (exact) return resolveScopePath(scope, exact[1].trim());
		return value.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
			const resolved = resolveScopePath(scope, path.trim());
			return resolved == null ? '' : String(resolved);
		});
	}
	if (Array.isArray(value)) return value.map((entry) => bindScopeValue(entry, scope));
	if (!typeGuard(recordSchema, value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, entry]) => [key, bindScopeValue(entry, scope)])
	);
}

function matchesFieldFilter(value: unknown, filter: unknown): boolean {
	if (!typeGuard(recordSchema, filter)) {
		return value === filter;
	}

	const operators = Object.entries(filter);
	if (operators.length === 0) return false;
	return operators.every(([operator, expected]) => {
		switch (operator) {
			case 'eq':
				return value === expected;
			case 'ne':
				return value !== expected;
			case 'in':
				return Array.isArray(expected) && expected.includes(value);
			case 'notIn':
				return Array.isArray(expected) && !expected.includes(value);
			case 'isNull':
				return typeof expected === 'boolean' && (expected ? value == null : value != null);
			case 'isNotNull':
				return typeof expected === 'boolean' && (expected ? value != null : value == null);
			case 'gt':
				return typeof value === 'number' && typeof expected === 'number' && value > expected;
			case 'gte':
				return typeof value === 'number' && typeof expected === 'number' && value >= expected;
			case 'lt':
				return typeof value === 'number' && typeof expected === 'number' && value < expected;
			case 'lte':
				return typeof value === 'number' && typeof expected === 'number' && value <= expected;
			default:
				return false;
		}
	});
}

function matchesWhereOnRecord(where: unknown, record: Record<string, unknown>): boolean {
	if (!typeGuard(recordSchema, where)) return false;
	if ('RAW' in where) return false;
	if ('AND' in where && Array.isArray(where.AND)) {
		if (!where.AND.every((entry) => matchesWhereOnRecord(entry, record))) return false;
	}
	if ('OR' in where && Array.isArray(where.OR)) {
		if (!where.OR.some((entry) => matchesWhereOnRecord(entry, record))) return false;
	}
	if ('NOT' in where) {
		if (matchesWhereOnRecord(where.NOT, record)) return false;
	}

	for (const [key, filter] of Object.entries(where)) {
		if (key === 'AND' || key === 'OR' || key === 'NOT' || key === '$sql') continue;
		if (!matchesFieldFilter(record[key], filter)) return false;
	}
	return true;
}

async function matchesSqlCondition(
	sqlExpression: string,
	context: TMutationActionContext,
	record: Record<string, unknown>,
	collectionName: string
): Promise<boolean> {
	const workspace = getWorkspace({ provision: true });
	const table = workspace.tableRegistry?.[collectionName];
	if (!table) return false;

	const params: unknown[] = [];
	const virtualColumns = Object.values(getColumns(table)).map((column) => {
		params.push(record[column.name] ?? null);
		return `$${params.length}::${column.getSQLType()} AS ${quoteSqlIdentifier(column.name)}`;
	});
	const boundExpression = sqlExpression.replace(/\$\{([^}]+)\}/g, (_match, path: string) => {
		params.push(resolveScopePath(context.scope, path.trim()));
		return `$${params.length}`;
	});
	const result = await workspace.tenantDb.query<{ matches: boolean }>(
		`SELECT COALESCE((${boundExpression}), false) AS matches FROM (SELECT ${virtualColumns.join(', ')}) AS mutation_record`,
		params
	);
	return result.rows[0]?.matches === true;
}

/** Whether persisted policy/approval conditions match the mutation's effective record. */
export async function mutationConditionsApply(
	conditions: Record<string, unknown>,
	context: TMutationActionContext,
	collectionName: string
): Promise<boolean> {
	if (isUnconditionalPolicyWhere(conditions)) return true;
	if ('RAW' in conditions) return false;
	const record = mutationRecord(context);
	const boundConditions = bindScopeValue(conditions, context.scope);
	if (!matchesWhereOnRecord(boundConditions, record)) return false;

	const sqlExpression = conditions.$sql;
	if (sqlExpression == null) return true;
	if (typeof sqlExpression !== 'string' || sqlExpression.trim().length === 0) return false;
	return matchesSqlCondition(sqlExpression, context, record, collectionName);
}
