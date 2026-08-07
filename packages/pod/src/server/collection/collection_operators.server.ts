import { type AnyRelationsFilter, type Operators, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { isUtcIsoInstant } from '@norbital-ai/std/date';
import { error } from './http_error.js';
import { vectorDistanceOperatorKeys } from './collection_vector.server.js';

/**
 * The vocabulary a collection `where` may use inside a single column's condition, and the only
 * server-side implementation of the operators Pod adds to Drizzle's.
 *
 * Drizzle's `relationsFieldFilterToSQL` ends in `operators[key](column, value)`, so a key it does
 * not recognise is a `TypeError` naming neither the collection, the field, nor the operator. Both
 * halves of that problem are solved here: `dateRangeFilter` compiles Pod's own operators to RAW
 * SQL before the filter reaches Drizzle, and `isKnownFieldOperator` rejects everything else at the
 * request boundary. The accepted set is derived from this file's own tables, so it cannot drift
 * from what the compiler actually supports.
 */

const utcInstantSchema = z.string().refine(isUtcIsoInstant);
const dateRangeSchema = z.object({ start: utcInstantSchema, end: utcInstantSchema });

/** Emits the predicate for one already-validated operand against a resolved column. */
type DateRangeSql = (column: unknown, sqlFn: Operators['sql']) => SQL;

/**
 * Pod's `dateRange()` operators. Each entry validates its operand eagerly and returns the SQL
 * builder for it, so a bad operand is a 400 before the query is built rather than a driver error.
 *
 * This is the single implementation: both the explicit `CollectionFilter[]` controls
 * (`collection_filters.server.ts`) and raw `where` objects (`collection_direct.ts`) compile
 * through it, which is what keeps the two paths — and the local replica in `ui/sync/local-sql.ts`
 * — agreeing on the same rows.
 */
const DATE_RANGE_PREDICATES = {
	contains_date: (operand: unknown): DateRangeSql => {
		if (typeof operand !== 'string' || !isUtcIsoInstant(operand)) {
			throw error(400, 'Date-range containment requires a UTC ISO instant.');
		}
		return (column, sqlFn) => sqlFn`(${column}->>'start')::timestamptz <= ${operand}::timestamptz
			and (${column}->>'end')::timestamptz >= ${operand}::timestamptz`;
	},
	overlaps: (operand: unknown): DateRangeSql => {
		const parsed = dateRangeSchema.safeParse(operand);
		if (!parsed.success) {
			throw error(400, 'Date-range overlap requires UTC ISO start and end instants.');
		}
		const { start, end } = parsed.data;
		return (column, sqlFn) => sqlFn`(${column}->>'start')::timestamptz <= ${end}::timestamptz
			and ${start}::timestamptz <= (${column}->>'end')::timestamptz`;
	}
} as const;

export type DateRangeOperator = keyof typeof DATE_RANGE_PREDICATES;

export function isDateRangeOperator(operator: string): operator is DateRangeOperator {
	return Object.hasOwn(DATE_RANGE_PREDICATES, operator);
}

/**
 * A `dateRange()` predicate as a Drizzle RAW filter. RAW is a *table-level* key, so the result can
 * be dropped anywhere a filter is accepted — top level, inside `AND`/`OR`/`NOT`, or inside a
 * relation filter object, where Drizzle hands the callback the related table's alias.
 */
export function dateRangeFilter(
	field: string,
	operator: DateRangeOperator,
	operand: unknown
): AnyRelationsFilter {
	const build = DATE_RANGE_PREDICATES[operator](operand);
	return {
		RAW: (table: unknown, operators: Operators): SQL => {
			const column = Reflect.get(table as object, field);
			if (!column) throw error(400, `Collection filter field '${field}' is unavailable.`);
			return build(column, operators.sql);
		}
	} as AnyRelationsFilter; // stupidity: boundary-cast — Drizzle's schema-erased RAW callback supplies the related table alias at runtime.
}

/**
 * Drizzle's own field-filter vocabulary: the keys `RelationFieldsFilterInternals`
 * (drizzle-orm/relations.d.ts) declares. It has to be written out because it is a *type* — there
 * is nothing to enumerate at runtime, and Drizzle's exported `operators` object is not the same
 * set (it also carries `and`, `or`, `not`, `between`, `exists`, `sql` … which are not column
 * conditions, and it spells `in`/`notIn` as `inArray`/`notInArray`).
 *
 * `in`/`notIn` and `isNull`/`isNotNull` are the two pairs `relationsFieldFilterToSQL` special-cases
 * — the first to `inArray`/`notInArray`, the second to a one-argument call — which is why they
 * appear here under names Drizzle's runtime `operators` object does not have.
 */
export const DRIZZLE_FIELD_OPERATORS = [
	'eq',
	'ne',
	'gt',
	'gte',
	'lt',
	'lte',
	'in',
	'notIn',
	'arrayContains',
	'arrayContained',
	'arrayOverlaps',
	'like',
	'ilike',
	'notLike',
	'notIlike',
	'isNull',
	'isNotNull'
] as const;

/** Structural keys Drizzle understands *inside* one column's condition. */
export const FIELD_CONDITION_STRUCTURAL_KEYS = ['AND', 'OR', 'NOT'] as const;

/** Every key a column condition may carry — Drizzle's, Pod's, and the structural three. */
export const ACCEPTED_FIELD_OPERATORS: ReadonlySet<string> = new Set<string>([
	...DRIZZLE_FIELD_OPERATORS,
	...Object.keys(DATE_RANGE_PREDICATES),
	...vectorDistanceOperatorKeys(),
	...FIELD_CONDITION_STRUCTURAL_KEYS
]);

export function isKnownFieldOperator(operator: string): boolean {
	return ACCEPTED_FIELD_OPERATORS.has(operator);
}

/** Rejects an unrecognised operator by name, saying where it was found and what is accepted. */
export function rejectUnknownFieldOperator(
	collection: string,
	field: string,
	operator: string
): never {
	throw error(
		400,
		`Collection '${collection}' field '${field}' has no filter operator '${operator}'. ` +
			`Accepted operators: ${[...ACCEPTED_FIELD_OPERATORS].sort().join(', ')}`
	);
}
