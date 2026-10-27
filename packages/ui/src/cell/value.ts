import type { FileRef } from '@norbital-ai/std/kind';
import type { Values } from '../model/types.js';
import { isRow } from '../read/results.js';
export const isMasked = (value: unknown) => isRow(value) && value['$masked'] === true;
export const isFile = (value: unknown): value is FileRef =>
	isRow(value) &&
	typeof value['id'] === 'string' &&
	typeof value['name'] === 'string' &&
	typeof value['mime'] === 'string';
export const filesOf = (value: unknown): readonly FileRef[] =>
	(Array.isArray(value) ? value : [value]).filter(isFile);
/** Typed text in the shape of a sample value of the same field: a number, a boolean, else the literal text. */
export function like(
	sample: import('@norbital-ai/std/kind').Value | undefined,
	text: string
): import('@norbital-ai/std/kind').Value {
	if (text === '') return null;
	const s = sample ?? null;
	if (typeof s === 'number') return Number(text);
	if (typeof s === 'boolean') return text === 'true';
	return text;
}
/** A field path's value (`'account.name'` reads a selected one-relation). */
export const valueAt = (
	row: Values,
	path: string
): import('@norbital-ai/std/kind').Value | undefined =>
	path
		.split('.')
		.reduce<import('@norbital-ai/std/kind').Value | undefined>(
			(v, k) => (isRow(v) ? v[k] : undefined),
			row
		);
