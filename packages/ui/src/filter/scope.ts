import type { Json } from '@norbital-ai/std/wire';
import { Predicate } from 'effect';
/** `and` of the author's scope and the viewer's clauses; the viewer never widens the author's `where` (final-ui rule 6). */
export function and(...parts: readonly (Json | undefined)[]): Json | undefined {
	const list = parts.filter(
		(p): p is Json =>
			p !== undefined && p !== null && !(Predicate.isObject(p) && Object.keys(p).length === 0)
	);
	return list.length === 0 ? undefined : list.length === 1 ? list[0] : { and: list };
}
/** Drops `undefined` members, so an options literal is `Json`. */
export const compact = (o: { readonly [k: string]: Json | undefined }): Json =>
	Object.fromEntries(Object.entries(o).filter((e): e is [string, Json] => e[1] !== undefined));
type Layer = {
	readonly where?: Json;
	readonly fields?: readonly string[];
	readonly limit?: number;
} & {
	readonly [option: string]: Json | undefined;
};
type Request = { readonly [path: string]: Layer };
/**
 * A read request scoped in three tiers, per path: the policy's (or author's) scope, a prefilter, then the viewer's.
 * `where`s AND, `fields` intersect, `limit` is the smallest; any other option the later tier states wins. No tier widens one before it.
 */
export function compose(policy: Request, prefilter: Request, user: Request): Request {
	const paths = new Set([...Object.keys(policy), ...Object.keys(prefilter), ...Object.keys(user)]);
	return Object.fromEntries(
		[...paths].map((path) => {
			const tiers = [policy[path], prefilter[path], user[path]].filter((t) => t !== undefined);
			const fields = tiers.flatMap((t) => (t.fields === undefined ? [] : [t.fields]));
			const limits = tiers.flatMap((t) => (t.limit === undefined ? [] : [t.limit]));
			const where = and(...tiers.map((t) => t.where));
			const layer: Layer = {
				...tiers.reduce((x: Layer, t) => ({ ...x, ...t }), {}),
				where,
				fields:
					fields.length === 0 ? undefined : fields.reduce((a, b) => a.filter((f) => b.includes(f))),
				limit: limits.length === 0 ? undefined : Math.min(...limits)
			};
			return [path, Object.fromEntries(Object.entries(layer).filter(([, v]) => v !== undefined))];
		})
	);
}
