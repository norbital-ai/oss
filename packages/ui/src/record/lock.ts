// A model's own-field lock, evaluated in the browser exactly as the host's `evaluate` does for the predicates the
// declaration language allows. Only the record's own scalar fields: a lock never reaches through a relation.
import { Array as Arr } from 'effect';
import type { Json, Value, Where } from '@norbital-ai/std/kind';
import { valueObject } from '../kinds/kind.js';
import type { Values } from '../model/types.js';

const value = (row: Values, field: string): Value =>
	field
		.split('.')
		.reduce<Value | undefined>((at, key) => (valueObject(at) ? at[key] : undefined), row) ?? null;
/** A `Where`'s members are JSON: a nested condition is its one object arm. */
const isWhere = (j: Json): j is Where =>
	typeof j === 'object' && j !== null && !Arr.isArray<Json>(j);
const compare = (left: Value, op: string, right: Json): boolean => {
	switch (op) {
		case 'eq':
			return JSON.stringify(left) === JSON.stringify(right);
		case 'ne':
			return JSON.stringify(left) !== JSON.stringify(right);
		case 'gt':
			return Number(left) > Number(right);
		case 'gte':
			return Number(left) >= Number(right);
		case 'lt':
			return Number(left) < Number(right);
		case 'lte':
			return Number(left) <= Number(right);
		case 'in':
			return (
				Array.isArray(right) && right.some((one) => JSON.stringify(one) === JSON.stringify(left))
			);
		case 'nin':
			return (
				Array.isArray(right) && right.every((one) => JSON.stringify(one) !== JSON.stringify(left))
			);
		case 'isNull':
			return left === null;
		case 'notNull':
			return left !== null;
		default:
			return false;
	}
};
/** Whether `row` matches a declared own-field lock (`{}` locks nothing). */
export function matchesLock(row: Values, where: Where | undefined): boolean {
	if (where === undefined) return false;
	const { and, or, not } = where;
	if (Arr.isArray<Json>(and)) return and.every((one) => isWhere(one) && matchesLock(row, one));
	if (Arr.isArray<Json>(or)) return or.some((one) => isWhere(one) && matchesLock(row, one));
	if (not !== undefined) return !(isWhere(not) && matchesLock(row, not));
	return Object.entries(where).every(([field, condition]) => {
		const left = value(row, field);
		return isWhere(condition)
			? Object.entries(condition).every(([op, right]) => compare(left, op, right))
			: compare(left, 'eq', condition);
	});
}
