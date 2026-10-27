// One read shape (a read request, the layer map `bolt.query` takes): what views build and how they take its answer apart.
import type { Json } from '@norbital-ai/std/wire';
import type { Row } from '../model/types.js';
import { isRow, rowsOf } from './results.js';

/** Every list's largest page: a read request's `limit` cap and default (an export reads up to it). */
export const READ_LIMIT = 10_000;
/** One layer of a read request: its filter, fields, order and page (`after` on a root only), and a search. */
export type Layer = {
	readonly where?: Json | undefined;
	readonly fields?: readonly string[] | undefined;
	readonly orderBy?: Json | undefined;
	readonly limit?: number | undefined;
	readonly after?: string | undefined;
	readonly search?: Json | undefined;
};
/** A read request as views build it: root and layer paths to their layers. */
export type Request = { readonly [path: string]: Layer };
/** A request as the wire JSON `bolt.query` takes, unset options dropped. */
export const requestJson = (request: Request): { readonly [path: string]: Json } =>
	Object.fromEntries(
		Object.entries(request).map(([path, layer]) => [
			path,
			Object.fromEntries(
				Object.entries(layer).filter((e): e is [string, Json] => e[1] !== undefined)
			)
		])
	);
/** The request reading one record of `of` by id (at most one row). */
export const byId = (
	of: string,
	id: string,
	fields?: readonly string[]
): { readonly [path: string]: Json } =>
	requestJson({ [of]: { where: { id: { eq: id } }, limit: 1, fields } });
/** Root `of`'s page of a request answer. */
export const pageOf = (answer: unknown, of: string): unknown =>
	isRow(answer) ? answer[of] : undefined;
/** Root `of`'s first row of a request answer (a `byId` read's record), or `null`; typed as the caller names it, as `query<T>` is. */
export const firstOf = <R extends Row = Row>(answer: unknown, of: string): R | null =>
	(rowsOf(pageOf(answer, of))[0] as R | undefined) ?? null;
/** The roots a read request names (`query({ … })`'s keys without a dot). */
export const rootsOf = (read: {
	readonly m: string;
	readonly a: readonly unknown[];
}): readonly string[] => {
	const request = read.a[0];
	return read.m === 'query' && isRow(request)
		? Object.keys(request).filter((path) => !path.includes('.'))
		: [];
};
