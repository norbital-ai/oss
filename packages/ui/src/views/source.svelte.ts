// A read-only view's source (§3.6) as one live read: a `bolt` query or live value, a collection query `{ query, input }`
// (re-run on its collection's commits, rule 64), or a local array.
import type { Json, Live, Q, Row, ViewBolt } from './bolt.js';
import { watch } from './live.svelte.js';
import { isRow, type ReadState } from './model.js';

export type ViewSource = Q<unknown> | Live<unknown> | { query: string; input?: Json } | readonly Row[];
const isLive = (s: ViewSource): s is Live<unknown> => 'subscribe' in s;

export function readSource(bolt: ViewBolt, source: () => ViewSource, every: () => string | undefined): { readonly state: ReadState<unknown> } {
	const live = watch(() => {
		const s = source();
		if (Array.isArray(s)) return null;
		if (isLive(s as ViewSource)) return s as Live<unknown>;
		const e = every(), o = e === undefined ? {} : { every: e };
		if (isRow(s) && typeof s['query'] === 'string') {
			const name = s['query'];
			return bolt.live(bolt.query(name, isRow(s['input']) ? s['input'] : {}), { ...o, on: [name.slice(0, name.lastIndexOf('.'))] });
		}
		return bolt.live(s as Q<unknown>, o);
	});
	return { get state() { const s = source(); return Array.isArray(s) ? { kind: 'ready' as const, value: s } : live.state; } };
}
