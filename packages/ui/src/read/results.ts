import type { Json } from '@norbital-ai/std/wire';
import type { Row, Values } from '../collection/types.js';
/** The signed-in member's id, or null for any other actor. */
export const actorId = (actor: Json): string | null =>
	isRow(actor) && typeof actor['id'] === 'string' ? actor['id'] : null;
export const isRow = (v: unknown): v is Values =>
	typeof v === 'object' && v !== null && !Array.isArray(v);
/** The rows of a `Page`, an array, or nothing. */
export const rowsOf = (v: unknown): readonly Row[] =>
	(Array.isArray(v) ? v : isRow(v) && Array.isArray(v['rows']) ? v['rows'] : []).filter(
		(row): row is Row => isRow(row) && typeof row['id'] === 'string'
	);
/** Object answers, including aggregate keys and history entries that are not record rows. */
export const objectsOf = (v: unknown): readonly Values[] =>
	(Array.isArray(v) ? v : isRow(v) && Array.isArray(v['rows']) ? v['rows'] : []).filter(isRow);
export const nextOf = (v: unknown): string | null =>
	isRow(v) && typeof v['next'] === 'string' ? v['next'] : null;
/** The count answer of `aggregate(c, { count: true, where })`. */
export const countOf = (v: unknown): number | null => {
	const r = Array.isArray(v) ? v[0] : v;
	return isRow(r) && typeof r['count'] === 'number'
		? r['count']
		: isRow(r) && typeof r['count'] === 'string'
			? Number(r['count'])
			: null;
};
