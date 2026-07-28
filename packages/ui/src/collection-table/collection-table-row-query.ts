import { textSearchMatches } from '@norbital-ai/std/string';
import { typeGuard } from '@norbital-ai/std/schema';
import type { CollectionFilter } from '@norbital-ai/platform-utils/collection';
import { z } from 'zod';

const recordSchema = z.record(z.string(), z.unknown());

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

export function collectionTableRowMatchesFilters(
	row: object,
	filters: readonly CollectionFilter[] | undefined
): boolean {
	return (filters ?? []).every((filter) => {
		let value: unknown = row;
		for (const segment of filter.path) {
			if (!typeGuard(recordSchema, value)) return false;
			value = Reflect.get(value, segment);
		}
		return matchesOperator(value, filter.operator, filter.operand);
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
		for (const [operator, operand] of Object.entries(condition)) {
			if (!matchesOperator(value, operator, operand)) return false;
		}
	}
	return true;
}
