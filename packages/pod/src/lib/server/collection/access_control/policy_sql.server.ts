import { sql, type AnyRelationsFilter, type SQL } from 'drizzle-orm';
import { POLICY_SQL_WHERE_KEY } from '$lib/authoring/workspace/db-api.js';
import {
	andRelationsFilters,
	compileRawSqlRelationsFilter,
	toRelationsFilter
} from '$lib/authoring/workspace/relations-filter.js';
import type { TBaseScope } from '$lib/shared/scope.js';
import { typeGuard } from '@norbital-ai/std/schema';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());

const SCOPE_VAR = /\$\{([^}]+)\}/g;

function flattenScope(value: Record<string, unknown>, prefix = ''): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (typeGuard(recordSchema, entry)) {
			Object.assign(out, flattenScope(entry, path));
		} else {
			out[path] = entry;
		}
	}
	return out;
}

function resolveScopePath(scope: Record<string, unknown>, path: string): unknown {
	const parts = path.split('.');
	let current: unknown = scope;
	for (const part of parts) {
		if (!typeGuard(recordSchema, current)) return undefined;
		current = current[part];
	}
	return current;
}

function parameterizedSql(sqlFn: typeof sql, text: string, params: unknown[]): SQL {
	const chunks: unknown[] = [];
	let last = 0;
	for (const match of text.matchAll(/\$(\d+)/g)) {
		const index = match.index ?? 0;
		if (index > last) {
			chunks.push(sqlFn.raw(text.slice(last, index)));
		}
		chunks.push(params[Number(match[1]) - 1]);
		last = index + match[0].length;
	}
	if (last < text.length) {
		chunks.push(sqlFn.raw(text.slice(last)));
	}
	return sqlFn.join(chunks as SQL[], sqlFn.empty());
}

function compileRawSqlFilter(sqlExpr: string, scope: Record<string, unknown>): AnyRelationsFilter {
	return compileRawSqlRelationsFilter(sqlExpr, scope, parameterizedSql);
}

function bindScopeInValue(
	value: unknown,
	scope: Record<string, unknown>,
	flatScope: Record<string, unknown>
): unknown {
	if (typeof value === 'string') {
		if (!value.includes('${')) return value;
		if (SCOPE_VAR.test(value) && value.replace(SCOPE_VAR, '').trim() === '') {
			const path = value.slice(2, -1).trim();
			return resolveScopePath(scope, path);
		}
		return value.replace(SCOPE_VAR, (_match, rawPath: string) => {
			const resolved = resolveScopePath(scope, rawPath.trim());
			return resolved == null ? '' : String(resolved);
		});
	}
	if (Array.isArray(value)) {
		return value.map((entry) => bindScopeInValue(entry, scope, flatScope));
	}
	if (typeGuard(recordSchema, value)) {
		if (POLICY_SQL_WHERE_KEY in value) {
			return compilePolicyWhereFromScope(value, scope, flatScope);
		}
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = bindScopeInValue(entry, scope, flatScope);
		}
		return out;
	}
	return value;
}

export function isUnconditionalPolicyWhere(conditions: unknown): boolean {
	if (conditions == null) return true;
	if (!typeGuard(recordSchema, conditions)) return false;
	return Object.keys(conditions).length === 0;
}

/** Compile persisted policy grant conditions into a Drizzle RQB `where` filter. */
export function compilePolicyWhere(
	conditions: Record<string, unknown> | null | undefined,
	scope: TBaseScope
): AnyRelationsFilter | null {
	if (isUnconditionalPolicyWhere(conditions)) return null;
	if (!typeGuard(recordSchema, conditions)) return null;
	return compilePolicyWhereFromScope(conditions, scope, flattenScope(scope));
}

function compilePolicyWhereFromScope(
	conditions: Record<string, unknown>,
	scope: Record<string, unknown>,
	flatScope: Record<string, unknown>
): AnyRelationsFilter | null {
	const source = conditions;
	const sqlExpr = source[POLICY_SQL_WHERE_KEY];
	const { [POLICY_SQL_WHERE_KEY]: _sql, ...rest } = source;

	const boundValue = bindScopeInValue(rest, scope, flatScope);
	const bound = typeGuard(recordSchema, boundValue)
		? toRelationsFilter(boundValue)
		: toRelationsFilter({});
	const hasRest = Object.keys(bound).length > 0;

	if (typeof sqlExpr === 'string' && sqlExpr.trim().length > 0) {
		const raw = compileRawSqlFilter(sqlExpr, flatScope);
		if (!hasRest) return raw;
		return andRelationsFilters(bound, raw);
	}

	return hasRest ? bound : null;
}
