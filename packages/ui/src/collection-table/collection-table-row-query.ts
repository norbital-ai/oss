import { textSearchMatches } from '@norbital-ai/std/string';
import { typeGuard } from '@norbital-ai/std/schema';
import type { CollectionFilter } from '@norbital-ai/platform-utils/collection';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());

/**
 * A filter whose path cannot be resolved against the row in hand.
 *
 * This is thrown rather than answered with `false` because those two are not the same statement.
 * "No row matched" is a result; "this predicate could not be evaluated" is a defect, and rendering
 * it as an empty table shows a filter that looks like it worked and quietly hides every record.
 * A caller filtering rows in memory should let this surface, or catch it and say the filter could
 * not be applied — never fold it into the result set.
 */
export class CollectionFilterPathError extends Error {
	readonly path: readonly string[];
	readonly segment: string;

	constructor(path: readonly string[], segment: string) {
		super(
			`Filter path "${path.join('.')}" cannot be resolved on this row: "${segment}" is not readable. ` +
				'The row is missing that field or relation — it was probably not selected by the query.'
		);
		this.name = 'CollectionFilterPathError';
		this.path = path;
		this.segment = segment;
	}
}

/**
 * Expands to-many hops so a path can be walked through them.
 *
 * A relation with `many` cardinality arrives as an array, and every level of the walk has to be
 * able to stand on one. Nested because a path may cross more than one of them.
 */
function flattenCandidates(values: readonly unknown[]): unknown[] {
	const flattened: unknown[] = [];
	for (const value of values) {
		if (Array.isArray(value)) flattened.push(...flattenCandidates(value));
		else flattened.push(value);
	}
	return flattened;
}

type PathResolution =
	| { readonly resolved: true; readonly values: readonly unknown[] }
	| { readonly resolved: false; readonly segment: string };

/**
 * Every value a filter path selects on one row.
 *
 * A path crossing a to-many relation selects one value per related record, and the caller matches
 * **existentially** — the row qualifies when any of them satisfies the operator. That is what
 * someone building `employment_employee.effective_range contains today` means, and it is what both
 * of the other two implementations of this predicate already do: the server compiles a relation
 * filter to Drizzle's `EXISTS`, and the local replica compiles one to an `EXISTS` subquery.
 *
 * An intermediate hop holding no record contributes nothing, so an unset to-one relation and an
 * empty to-many both simply fail to match — `EXISTS` over an empty set, again matching the other
 * two. A *leaf* that is null is a different thing and is kept, so `isNull` still works on a column.
 *
 * The values are returned unflattened at the leaf: an array-typed column has to reach
 * `arrayContains` as the array itself, not as its elements.
 */
function resolveFilterPath(row: object, path: readonly string[]): PathResolution {
	let frontier: unknown[] = [row];
	for (const segment of path) {
		const next: unknown[] = [];
		for (const candidate of flattenCandidates(frontier)) {
			if (candidate == null) continue;
			// Descending into a scalar is the unresolvable case: the row does not have the shape the
			// path describes, and no answer about matching can honestly be given.
			if (!typeGuard(recordSchema, candidate)) return { resolved: false, segment };
			if (!(segment in candidate)) return { resolved: false, segment };
			next.push(Reflect.get(candidate, segment));
		}
		frontier = next;
	}
	return { resolved: true, values: frontier };
}

function searchableValue(value: unknown): string {
	if (value == null) return '';
	if (typeof value === 'object') return JSON.stringify(value) ?? '';
	return String(value);
}

function compareValues(left: unknown, right: unknown): number | null {
	if (typeof left === 'number' && typeof right === 'number') return left - right;
	if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
	return null;
}

function valuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length && left.every((value, index) => valuesEqual(value, right[index]))
		);
	}
	if (typeGuard(recordSchema, left) && typeGuard(recordSchema, right)) {
		const entries = Object.entries(right);
		return entries.every(([key, value]) => valuesEqual(Reflect.get(left, key), value));
	}
	return false;
}

function containsValue(value: unknown, operand: unknown): boolean {
	if (typeof value === 'string') return value.includes(String(operand ?? ''));
	if (Array.isArray(value)) {
		const expected = Array.isArray(operand) ? operand : [operand];
		return expected.every((candidate) => value.some((item) => valuesEqual(item, candidate)));
	}
	return typeGuard(recordSchema, value) && typeGuard(recordSchema, operand)
		? valuesEqual(value, operand)
		: false;
}

function dateRange(value: unknown): { start: string; end: string } | null {
	if (!typeGuard(recordSchema, value)) return null;
	const start = Reflect.get(value, 'start');
	const end = Reflect.get(value, 'end');
	return typeof start === 'string' && typeof end === 'string' ? { start, end } : null;
}

export function collectionTableRowMatchesSearch(row: object, search: string): boolean {
	return textSearchMatches(Object.values(row).map(searchableValue).join(' '), search);
}

/**
 * Every operator `matchesOperator` answers, which is what tells an operator map apart from a nested
 * relation condition in a `where`. It must stay in step with the switch below: an operator missing
 * here would make its condition read as a relation name and quietly match nothing.
 */
const FILTER_OPERATORS: ReadonlySet<string> = new Set([
	'eq',
	'ne',
	'gt',
	'gte',
	'lt',
	'lte',
	'ilike',
	'isNull',
	'isNotNull',
	'contains',
	'in',
	'notIn',
	'arrayContains',
	'arrayOverlaps',
	'contains_date',
	'overlaps'
]);

/** A condition is an operator map only when every key is one; otherwise it describes a relation. */
function isOperatorMap(condition: Readonly<Record<string, unknown>>): boolean {
	const keys = Object.keys(condition);
	return keys.length > 0 && keys.every((key) => FILTER_OPERATORS.has(key));
}

function matchesOperator(value: unknown, operator: string, operand: unknown): boolean {
	switch (operator) {
		case 'eq':
			return valuesEqual(value, operand);
		case 'ne':
			return !valuesEqual(value, operand);
		case 'gt':
			return (compareValues(value, operand) ?? 0) > 0;
		case 'gte':
			return (compareValues(value, operand) ?? -1) >= 0;
		case 'lt':
			return (compareValues(value, operand) ?? 0) < 0;
		case 'lte':
			return (compareValues(value, operand) ?? 1) <= 0;
		case 'ilike':
			return searchableValue(value)
				.toLocaleLowerCase()
				.includes(
					String(operand ?? '')
						.replaceAll('%', '')
						.toLocaleLowerCase()
				);
		case 'isNull':
			return value == null;
		case 'isNotNull':
			return value != null;
		case 'contains':
			return containsValue(value, operand);
		case 'in':
			return Array.isArray(operand) && operand.some((item) => valuesEqual(value, item));
		case 'notIn':
			return Array.isArray(operand) && operand.every((item) => !valuesEqual(value, item));
		case 'arrayContains':
			return containsValue(value, operand);
		case 'arrayOverlaps':
			return (
				Array.isArray(value) &&
				Array.isArray(operand) &&
				operand.some((candidate) => value.some((item) => valuesEqual(item, candidate)))
			);
		case 'contains_date': {
			const range = dateRange(value);
			const date = typeof operand === 'string' ? operand : null;
			return range != null && date != null && range.start <= date && date <= range.end;
		}
		case 'overlaps': {
			const left = dateRange(value);
			const right = dateRange(operand);
			return left != null && right != null && left.start <= right.end && right.start <= left.end;
		}
		default:
			return false;
	}
}

/**
 * @throws {CollectionFilterPathError} when a path cannot be resolved against `row`. A predicate
 * that cannot be evaluated must not answer "did not match" — see the error's own note.
 */
export function collectionTableRowMatchesFilters(
	row: object,
	filters: readonly CollectionFilter[] | undefined
): boolean {
	return (filters ?? []).every((filter) => {
		const resolution = resolveFilterPath(row, filter.path);
		if (!resolution.resolved) {
			throw new CollectionFilterPathError(filter.path, resolution.segment);
		}
		return resolution.values.some((value) =>
			matchesOperator(value, filter.operator, filter.operand)
		);
	});
}

export function collectionTableRowMatchesWhere(
	row: object,
	where: Readonly<Record<string, unknown>> | undefined
): boolean {
	if (!where) return true;
	for (const [field, condition] of Object.entries(where)) {
		if (field === 'AND' && Array.isArray(condition)) {
			if (
				!condition.every(
					(entry) => typeGuard(recordSchema, entry) && collectionTableRowMatchesWhere(row, entry)
				)
			)
				return false;
			continue;
		}
		if (field === 'OR' && Array.isArray(condition)) {
			if (
				!condition.some(
					(entry) => typeGuard(recordSchema, entry) && collectionTableRowMatchesWhere(row, entry)
				)
			)
				return false;
			continue;
		}
		if (field === 'NOT' && typeGuard(recordSchema, condition)) {
			if (collectionTableRowMatchesWhere(row, condition)) return false;
			continue;
		}
		const value = Reflect.get(row, field);
		if (!typeGuard(recordSchema, condition)) {
			if (value !== condition) return false;
			continue;
		}
		// A relation name in `where` filters by the existence of a matching related record, so its
		// condition is a nested `where` rather than an operator map. Read as an operator map it would
		// hand a to-many's array to `matchesOperator`, which knows no operator called `effective_range`
		// and answers `false` — emptying the table while looking like a filter that simply matched
		// nothing. The keys decide which of the two this is.
		if (!isOperatorMap(condition)) {
			const related = flattenCandidates([value]).filter((candidate) => candidate != null);
			if (
				!related.some(
					(candidate) =>
						typeGuard(recordSchema, candidate) &&
						collectionTableRowMatchesWhere(candidate, condition)
				)
			) {
				return false;
			}
			continue;
		}
		for (const [operator, operand] of Object.entries(condition)) {
			if (!matchesOperator(value, operator, operand)) return false;
		}
	}
	return true;
}
