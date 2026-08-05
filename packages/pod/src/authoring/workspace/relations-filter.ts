import type { AnyDBQueryConfig, AnyRelationsFilter } from 'drizzle-orm';
import { sql, type SQL } from 'drizzle-orm';
import { typeGuard } from '@norbital-ai/std/schema';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());

/**
 * Plain column-operator where objects used by server-side collection ops.
 *
 * The cast cannot be narrowed usefully: column names are dynamic strings, so any type able to
 * accept them also accepts an arbitrary operator key, and spelling the operator vocabulary out
 * here would be a second copy of the list that `collection/collection_operators.server.ts` owns.
 * The contract is therefore positional — only hand this filters Pod built itself, or the output of
 * `collection_direct.ts`'s `compileQuery`, which is the single place a caller-supplied `where` is
 * checked. Passing wire input straight through is what let an unknown operator reach Drizzle and
 * be called as a function.
 */
export function toRelationsFilter(where: Record<string, unknown>): AnyRelationsFilter {
	// Safe: RQB where clauses are plain column-operator maps at runtime; Drizzle types them per-schema.
	return where as AnyRelationsFilter;
}

/** Plain nested expand maps used by server-side collection ops. */
export function toRelationsWith(
	withClause: Record<string, unknown> | undefined
): AnyDBQueryConfig['with'] | undefined {
	if (withClause === undefined) return undefined;
	// Safe: RQB with clauses are plain nested expand maps at runtime; Drizzle types them per-schema.
	return withClause as AnyDBQueryConfig['with'];
}

export function andRelationsFilters(...filters: readonly AnyRelationsFilter[]): AnyRelationsFilter {
	// Safe: Drizzle RQB accepts AND arrays of relation filters with identical runtime shape.
	return { AND: [...filters] } as AnyRelationsFilter;
}

export function compileRawSqlRelationsFilter(
	sqlExpr: string,
	scope: Record<string, unknown>,
	parameterizedSql: (sqlFn: typeof sql, text: string, params: unknown[]) => SQL
): AnyRelationsFilter {
	const params: unknown[] = [];
	const SCOPE_VAR = /\$\{([^}]+)\}/g;
	const text = sqlExpr.replace(SCOPE_VAR, (_match, rawPath: string) => {
		const path = rawPath.trim();
		if (!(path in scope)) {
			throw new Error(`Unknown policy scope variable: ${path}`);
		}
		params.push(scope[path]);
		return `$${params.length}`;
	});
	// Safe: Drizzle RAW where callbacks are structurally valid RQB filters at runtime.
	return {
		RAW: (_table: unknown, operators: { sql: typeof sql }) =>
			parameterizedSql(operators.sql, text, params)
	} as unknown as AnyRelationsFilter; // stupidity: boundary-cast — Drizzle's callback filter is opaque and non-serializable.
}
