// A model's own-field lock, evaluated in the browser exactly as the host's `evaluate` does for the predicates the
// declaration language allows. Only the record's own scalar fields: a lock never reaches through a relation.
import type { Json, Where } from '@norbital-ai/std/kind';

type Row = Readonly<Record<string, unknown>>;
const value = (row: Row, field: string): Json => {
	const found = field
		.split('.')
		.reduce<unknown>(
			(at, key) => (typeof at === 'object' && at !== null ? (at as Row)[key] : undefined),
			row
		);
	return (found ?? null) as Json;
};
const compare = (left: Json, op: string, right: Json): boolean => {
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
export function matchesLock(row: Row, where: Where | undefined): boolean {
	if (where === undefined) return false;
	const any = where as Readonly<Record<string, Json>>;
	if (Array.isArray(any['and']))
		return (any['and'] as readonly Where[]).every((one) => matchesLock(row, one));
	if (Array.isArray(any['or']))
		return (any['or'] as readonly Where[]).some((one) => matchesLock(row, one));
	if (any['not'] !== undefined) return !matchesLock(row, any['not'] as Where);
	return Object.entries(any).every(([field, condition]) => {
		const left = value(row, field);
		if (condition === null || typeof condition !== 'object' || Array.isArray(condition))
			return compare(left, 'eq', condition);
		return Object.entries(condition).every(([op, right]) => compare(left, op, right as Json));
	});
}
