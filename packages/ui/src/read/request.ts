// One read shape (a read request, the layer map `bolt.query` takes): what views build and how they take its answer apart.
import { Predicate } from 'effect';
import type { Json } from '@norbital-ai/store/wire';
import type { QueryAnswer, WireRead } from '../client/contract.js';
import type { Page } from '../model/types.js';

/** Every list's largest page: a read request's `limit` cap and default (an export reads up to it). */
export const READ_LIMIT = 10_000;
/** One layer of a read request: its filter, fields, order and page (`after` on a root only), and a search. */
export type Layer = {
	readonly where?: Json | undefined;
	readonly fields?: readonly string[] | undefined;
	readonly order_by?: Json | undefined;
	readonly limit?: number | undefined;
	readonly after?: string | undefined;
	readonly search?: Json | undefined;
};
/** A read request as views build it: root and layer paths to their layers. */
export type Request = { readonly [path: string]: Layer };
/** A request as the wire JSON `bolt.query` takes, unset options dropped. */
export function request_json(request: Request): { readonly [root: string]: { readonly [key: string]: Json } } {
	const tree: Record<string, Record<string, Json>> = {};
	const nodes = new Map<string, Record<string, Json>>();
	const nodeAt = (path: string): Record<string, Json> => {
		const known = nodes.get(path);
		if (known !== undefined) return known;
		const node: Record<string, Json> = {};
		nodes.set(path, node);
		const dot = path.lastIndexOf('.');
		Object.defineProperty(dot < 0 ? tree : nodeAt(path.slice(0, dot)), dot < 0 ? path : path.slice(dot + 1), {
			value: node, enumerable: true, configurable: true, writable: true
		});
		return node;
	};
	for (const [path, layer] of Object.entries(request))
		Object.assign(nodeAt(path), Object.fromEntries(
			Object.entries(layer).filter((entry): entry is [string, Json] => entry[1] !== undefined)
		));
	return tree;
}
/** The request reading one record of `of` by id (at most one row). */
export const by_id = (
	of: string,
	id: string,
	fields?: readonly string[]
): { readonly [path: string]: Json } =>
	request_json({ [of]: { where: { id: { eq: id } }, limit: 1, fields } });
/** Root `of`'s page of a request answer; `undefined` when the answer has no such root. */
export const page_of = <R>(answer: QueryAnswer<R>, of: string): Page<R> | undefined => answer[of];
/** Root `of`'s first row of a request answer (a `by_id` read's record), or `null`. */
export const first_of = <R>(answer: QueryAnswer<R>, of: string): R | null =>
	page_of(answer, of)?.rows[0] ?? null;
/** The roots a read request names (`query({ … })`'s keys without a dot). */
export const roots_of = (read: WireRead): readonly string[] => {
	const request = read.a[0];
	return read.m === 'query' && Predicate.isObject(request)
		? Object.keys(request).filter((path) => !path.includes('.'))
		: [];
};
