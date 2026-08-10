import { getColumns, type AnyRelationsFilter, type Operators, type SQL } from 'drizzle-orm';
import { type AnyPgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import type { ProvisionedContext } from '$lib/server/bootstrap/workspace_store.js';
import { error } from './http_error.js';
import { quoteSqlIdentifier } from './sql-identifier.server.js';

/** Distance metrics for `vector(n)` columns (pgvector). */
export const VECTOR_DISTANCE_METRICS = ['cosine', 'l2', 'ip'] as const;
export type VectorDistanceMetric = (typeof VECTOR_DISTANCE_METRICS)[number];

const withinDistanceSchema = z.object({
	probe: z.array(z.number().finite()).min(1),
	maxDistance: z.number().finite().nonnegative(),
	metric: z.enum(VECTOR_DISTANCE_METRICS).default('cosine')
});

const findNearestSchema = z.object({
	column: z.string().min(1),
	probe: z.array(z.number().finite()).min(1),
	metric: z.enum(VECTOR_DISTANCE_METRICS),
	maxDistance: z.number().finite().nonnegative().optional(),
	limit: z.number().int().positive().max(5000),
	excludeIds: z.array(z.string().uuid()).optional()
});

export type FindNearestQuery = z.infer<typeof findNearestSchema>;

/**
 * Structural input accepted from the client surface.
 *
 * The client-facing `FindNearestConfig` declares `probe`/`excludeIds` as readonly and `metric`
 * as the named `FindNearestMetric` union, which the zod-inferred `FindNearestQuery` (mutable
 * arrays, literal metric) does not accept. The zod parse inside validates the same shape, so
 * the server entry points take this wider type and parse before use.
 */
export type FindNearestInput = {
	readonly column: string;
	readonly probe: readonly number[];
	readonly metric: VectorDistanceMetric;
	readonly maxDistance?: number;
	readonly limit: number;
	readonly excludeIds?: readonly string[];
};

export type FindNearestRow = Record<string, unknown> & { readonly distance: number };

type VectorSql = (column: unknown, sqlFn: Operators['sql']) => SQL;

function distanceOperatorSql(metric: VectorDistanceMetric): string {
	switch (metric) {
		case 'cosine':
			return '<=>';
		case 'l2':
			return '<->';
		case 'ip':
			return '<#>';
		default: {
			const _exhaustive: never = metric;
			return _exhaustive;
		}
	}
}

const VECTOR_PREDICATES = {
	withinDistance: (operand: unknown): VectorSql => {
		const parsed = withinDistanceSchema.safeParse(operand);
		if (!parsed.success) {
			throw error(
				400,
				'withinDistance requires { probe: number[], maxDistance: number, metric?: cosine|l2|ip }.'
			);
		}
		const vectorLiteral = JSON.stringify(parsed.data.probe);
		const { maxDistance, metric } = parsed.data;
		switch (metric) {
			case 'cosine':
				return (column, sqlFn) => sqlFn`(${column} <=> ${vectorLiteral}::vector) <= ${maxDistance}`;
			case 'l2':
				return (column, sqlFn) => sqlFn`(${column} <-> ${vectorLiteral}::vector) <= ${maxDistance}`;
			case 'ip':
				return (column, sqlFn) => sqlFn`(${column} <#> ${vectorLiteral}::vector) <= ${maxDistance}`;
			default: {
				const _exhaustive: never = metric;
				return _exhaustive;
			}
		}
	}
} as const;

export type VectorDistanceOperator = keyof typeof VECTOR_PREDICATES;

export function isVectorDistanceOperator(operator: string): operator is VectorDistanceOperator {
	return Object.hasOwn(VECTOR_PREDICATES, operator);
}

export function vectorDistanceFilter(
	field: string,
	operator: VectorDistanceOperator,
	operand: unknown
): AnyRelationsFilter {
	const build = VECTOR_PREDICATES[operator](operand);
	return {
		RAW: (table: unknown, operators: Operators): SQL => {
			const column = Reflect.get(table as object, field);
			if (!column) throw error(400, `Collection filter field '${field}' is unavailable.`);
			return build(column, operators.sql);
		}
	} as AnyRelationsFilter; // stupidity: boundary-cast — Drizzle's schema-erased RAW callback supplies the related table alias at runtime.
}

export function vectorDistanceOperatorKeys(): readonly string[] {
	return Object.keys(VECTOR_PREDICATES);
}

function normalizeVectorProbe(probe: readonly number[], expectedLength?: number): string {
	if (expectedLength != null && probe.length !== expectedLength) {
		throw error(
			400,
			`Vector probe length ${probe.length} does not match column vector(${expectedLength}).`
		);
	}
	return JSON.stringify(probe);
}

function columnLength(column: AnyPgColumn): number | undefined {
	return typeof column.length === 'number' && column.length > 0 ? column.length : undefined;
}

function tableForCollection(ctx: ProvisionedContext, collectionName: string): PgTable {
	const table = ctx.tableRegistry?.[collectionName];
	if (!table) {
		throw error(404, `Unknown collection '${collectionName}'.`);
	}
	return table;
}

/**
 * Server-only nearest-neighbor lookup on `vector(n)` via pgvector.
 *
 * Uses `ORDER BY column <op> probe` so HNSW/IVFFlat indexes can participate.
 * One path for PDQ-as-binary-embedding (L2), Gemini omni embeddings (cosine), etc.
 */
export async function directFindNearest(
	ctx: ProvisionedContext,
	collection: string,
	query: FindNearestInput
): Promise<FindNearestRow[]> {
	const parsed = findNearestSchema.parse(query);
	const table = tableForCollection(ctx, collection);
	const columns = getColumns(table);
	const column = columns[parsed.column];
	if (!column) {
		throw error(
			400,
			`Collection '${collection}' has no column '${parsed.column}' for findNearest.`
		);
	}

	const sqlType = column.getSQLType().toLowerCase();
	if (!sqlType.startsWith('vector')) {
		throw error(400, `findNearest requires a vector(n) column; got ${sqlType}.`);
	}

	const length = columnLength(column);
	const op = distanceOperatorSql(parsed.metric);
	const probeParam = normalizeVectorProbe(parsed.probe, length);
	const castType = length != null ? `vector(${length})` : 'vector';

	const tableSql = quoteSqlIdentifier(collection);
	const columnSql = quoteSqlIdentifier(parsed.column);
	const params: unknown[] = [probeParam];
	const predicates: string[] = [];

	if (parsed.maxDistance != null) {
		params.push(parsed.maxDistance);
		predicates.push(`(${columnSql} ${op} $1::${castType}) <= $${params.length}`);
	}

	if (parsed.excludeIds?.length) {
		params.push(parsed.excludeIds);
		predicates.push(
			`${quoteSqlIdentifier(SYSTEM_COLUMN_NAMES.PKEY)} <> ALL($${params.length}::uuid[])`
		);
	}

	params.push(parsed.limit);
	const limitParam = `$${params.length}`;
	const whereSql = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';

	const result = await ctx.tenantDb.query<Record<string, unknown>>(
		`SELECT *, (${columnSql} ${op} $1::${castType})::float8 AS distance
		   FROM ${tableSql}
		   ${whereSql}
		  ORDER BY ${columnSql} ${op} $1::${castType}
		  LIMIT ${limitParam}`,
		params
	);

	return result.rows.map((row) => {
		const distance = Number(row.distance);
		return { ...row, distance };
	});
}
