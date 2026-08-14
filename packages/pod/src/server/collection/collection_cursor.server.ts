import { Buffer } from 'node:buffer';
import { SYSTEM_COLUMN_NAMES } from '@norbital-ai/platform-utils/system/column_names';
import { type AnyColumn, type AnyRelationsFilter, type Operators, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { error } from '$lib/server/http.js';

export type CursorOrder = Readonly<Record<string, 'asc' | 'desc'>>;

const cursorValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const cursorSchema = z.object({
	v: z.literal(1),
	order: z
		.array(
			z.object({
				field: z.string().min(1),
				direction: z.enum(['asc', 'desc']),
				value: cursorValueSchema
			})
		)
		.min(1)
		.max(20)
});

type CursorPayload = z.infer<typeof cursorSchema>;
type CursorEntry = CursorPayload['order'][number];

export function normalizeCursorOrder(orderBy: CursorOrder | undefined): CursorOrder {
	const entries = Object.entries(orderBy ?? {});
	if (!entries.some(([field]) => field === SYSTEM_COLUMN_NAMES.PKEY)) {
		entries.push([SYSTEM_COLUMN_NAMES.PKEY, 'asc']);
	}
	return Object.fromEntries(entries);
}

function normalizedCursorValue(value: unknown): z.infer<typeof cursorValueSchema> {
	if (value instanceof Date) return value.toISOString();
	const parsed = cursorValueSchema.safeParse(value);
	if (parsed.success) return parsed.data;
	throw error(400, 'Cursor pagination requires scalar order fields.');
}

export function encodeCollectionCursor(row: Record<string, unknown>, orderBy: CursorOrder): string {
	const payload: CursorPayload = {
		v: 1,
		order: Object.entries(orderBy).map(([field, direction]) => ({
			field,
			direction,
			value: normalizedCursorValue(row[field])
		}))
	};
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCollectionCursor(cursor: string, orderBy: CursorOrder): readonly CursorEntry[] {
	let parsed: CursorPayload;
	try {
		parsed = cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
	} catch {
		throw error(400, 'Invalid collection cursor.');
	}

	const expected = Object.entries(orderBy);
	const matches =
		parsed.order.length === expected.length &&
		parsed.order.every(
			(entry, index) =>
				entry.field === expected[index]?.[0] && entry.direction === expected[index]?.[1]
		);
	if (!matches) throw error(400, 'Collection cursor does not match the active sort.');
	return parsed.order;
}

function tableColumn(table: unknown, field: string): AnyColumn {
	const column = Reflect.get(table as object, field);
	if (!column) throw error(400, `Collection cursor field '${field}' is unavailable.`);
	return column as AnyColumn; // stupidity: boundary-cast — Drizzle erases the table alias in RAW relation callbacks.
}

function equalPredicate(column: AnyColumn, value: CursorEntry['value'], operators: Operators): SQL {
	return value === null ? operators.isNull(column) : operators.eq(column, value);
}

function afterPredicate(
	column: AnyColumn,
	entry: CursorEntry,
	operators: Operators
): SQL | undefined {
	if (entry.direction === 'asc') {
		if (entry.value === null) return undefined;
		return operators.or(operators.gt(column, entry.value), operators.isNull(column));
	}
	if (entry.value === null) return operators.isNotNull(column);
	return operators.lt(column, entry.value);
}

export function collectionCursorWhere(
	cursor: string | undefined,
	orderBy: CursorOrder
): AnyRelationsFilter | undefined {
	if (!cursor) return undefined;
	const entries = decodeCollectionCursor(cursor, orderBy);
	return {
		RAW: (table: unknown, operators: Operators): SQL => {
			const branches = entries.flatMap((entry, index) => {
				const after = afterPredicate(tableColumn(table, entry.field), entry, operators);
				if (!after) return [];
				const prefix = entries
					.slice(0, index)
					.map((prior) => equalPredicate(tableColumn(table, prior.field), prior.value, operators));
				return [operators.and(...prefix, after)];
			});
			const predicate = operators.or(...branches);
			if (!predicate) return operators.sql`false`;
			return predicate;
		}
	} as AnyRelationsFilter; // stupidity: boundary-cast — Drizzle's schema-erased RAW callback is the supported keyset predicate boundary.
}
