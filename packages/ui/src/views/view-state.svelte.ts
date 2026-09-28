// The view popover's state for a `Table` or `Board` (rule 16b): filter rows and sort keys, read strictly from the URL
// (or `initialFilter`) once, kept in the URL, and lowered to the `where`/`orderBy` a read sends.
import { untrack } from 'svelte';
import type { CollectionExposure } from '../kinds/context.js';
import type { Json, ViewBolt } from './bolt.js';
import {
	clauses, fromWhere, orderKeys, orderOf, orderText, parseOrder, readViewUrl, rowsWhere, sortable, toWhere, writeViewUrl, type Node, type SortKey, type Where,
} from './filter.js';
import { msg } from './model.js';

type Catalog = { readonly [collection: string]: CollectionExposure };
export type ViewState = ReturnType<typeof viewState>;

export function viewState(bolt: ViewBolt, o: { key: () => string; collection: () => string; catalog: () => Catalog; initialFilter: () => Json | undefined }) {
	const params = () => typeof location === 'undefined' ? new URLSearchParams() : new URL(location.href).searchParams;
	const DROPPED = () => msg(bolt, 'view.dropped', 'A filter or sort from the link no longer applies and was removed');

	/** `bolt.decode` per top-level clause (it keeps or drops each top-level key; an `and` list is one key), or null when the
	 * client has none (a local array, a test host): the typed rows then are the check. */
	function decode(c: string, q: { where?: Json; orderBy?: Json }) {
		if (bolt.decode === undefined || c.startsWith('$')) return null;
		try { return bolt.decode(c, q); } catch { return null; }
	}
	/** URL → rows and keys: each top-level clause and key decoded alone; the bad ones dropped with one notice. */
	function load() {
		const c = o.collection(), cat = o.catalog(), url = readViewUrl(params(), o.key());
		const fromUrl = url.where !== undefined;
		let dropped = url.badJson ? 1 : 0;
		const rows: Node[] = [];
		for (const clause of clauses(url.where ?? o.initialFilter() ?? null)) {
			const d = decode(c, { where: clause });
			const n = d !== null && d.dropped.length > 0 ? null : fromWhere(cat, c, clause);
			if (n !== null) rows.push(...n);
			else if (fromUrl) dropped++;
		}
		let text = url.order ?? '';
		const d = text === '' ? null : decode(c, { orderBy: orderOf(parseOrder(text, null).keys) });
		if (d !== null) { dropped += d.dropped.length; text = orderText(orderKeys(d.orderBy)); }
		const order = parseOrder(text, cat[c] === undefined ? null : sortable(cat[c], !c.startsWith('$'), cat));
		return { rows, order: order.keys, touched: fromUrl, notice: dropped + order.dropped > 0 ? DROPPED() : null };
	}
	const first = untrack(load);
	let rows = $state<readonly Node[]>(first.rows);
	let order = $state<readonly SortKey[]>(first.order);
	let touched = $state(first.touched);
	let notice = $state<string | null>(first.notice);

	// what the read sends: the viewer's rows, each re-checked by `bolt.decode` when the client has it (rule 11a)
	const lowered = $derived.by(() => {
		const c = o.collection(), parts: Where[] = [];
		let dropped = 0;
		for (const n of rows) {
			const w = toWhere(o.catalog(), c, n);
			if (w === null) continue;
			const d = decode(c, { where: w });
			if (d !== null && d.dropped.length > 0) dropped++; else parts.push(w);
		}
		return { where: parts.length === 0 ? undefined : parts.length === 1 ? parts[0]! : { and: parts }, dropped };
	});
	$effect(() => {
		const next = writeViewUrl(params(), o.key(), { where: rowsWhere(o.catalog(), o.collection(), rows), touched, order });
		if (typeof location !== 'undefined') history.replaceState(history.state, '', `${location.pathname}${next.size > 0 ? `?${next}` : ''}${location.hash}`);
	});

	return {
		get rows() { return rows; },
		get order() { return order; },
		get where(): Where | undefined { return lowered.where; },
		get notice() { return notice ?? (lowered.dropped > 0 ? DROPPED() : null); },
		setRows(next: readonly Node[]) { rows = next; touched = true; notice = null; },
		setOrder(next: readonly SortKey[]) { order = next; },
		clear() { rows = []; order = []; touched = true; notice = null; },
		/** Rule 16a: the description's `Where` and `OrderBy` replace the rows (and the sort, when it asks for one). */
		async describe(text: string): Promise<boolean> {
			const fail = () => { notice = msg(bolt, 'view.describeFailed', 'Could not build a filter from that description'); return false; };
			if (bolt.describe === undefined || text.trim() === '') return false;
			try {
				const c = o.collection();
				const fields = c.startsWith('$') ? Object.entries(o.catalog()[c]?.fields ?? {}).flatMap(([name, field]) =>
					field.kind === 'text' || field.kind === 'number' || field.kind === 'bool'
						? [{ name, label: field.label ?? name, kind: field.kind, optional: field.optional === true }] : []) : undefined;
				const r = await bolt.describe(c, text.trim(), fields);
				const parts = clauses(r.where).map((cl) => fromWhere(o.catalog(), o.collection(), cl));
				const keys = r.orderBy === undefined ? null : parseOrder(orderText(orderKeys(r.orderBy)), sortable(o.catalog()[o.collection()], !o.collection().startsWith('$'), o.catalog()));
				if (parts.some((p) => p === null) || (keys !== null && keys.dropped > 0)) return fail();
				rows = parts.flatMap((p) => p!);
				touched = true;
				notice = null;
				if (keys !== null) order = keys.keys;
				return true;
			} catch {
				return fail();
			}
		},
	};
}
