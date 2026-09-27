// A `Live<T>` read while the component renders it (rule 64): the subscription follows `source()`, and the view outlives
// its last reader by the client's grace, so paging back and forth reuses the open view.
import { SvelteMap } from 'svelte/reactivity';
import type { CollectionExposure } from '../kinds/context.js';
import type { Live, Row, ViewBolt } from './bolt.js';
import { label, msg, readState, show, type ReadState } from './model.js';

export function watch<T>(source: () => Live<T> | null): { readonly state: ReadState<T>; readonly value: T | undefined } {
	let value = $state<T | undefined>(undefined);
	let state = $state<ReadState<T>>({ kind: 'loading' });
	$effect(() => {
		const live = source();
		if (live === null) return;
		state = { kind: 'loading' };
		return live.subscribe((v) => {
			value = v;
			state = readState(v, live.error);
		});
	});
	return { get state() { return state; }, get value() { return value; } };
}

/**
 * A relation value's words (a filter chip, the author's scope): the record's declared label, read once per record; "…"
 * while it loads. Never the id: a record the viewer cannot read says so.
 */
export function recordLabels(bolt: Pick<ViewBolt, 'get' | 't' | 'locale'>, catalog: () => { readonly [c: string]: CollectionExposure } | undefined) {
	const known = new SvelteMap<string, string>();
	const asked = new Set<string>();
	return (target: string, id: string): string => {
		const key = `${target}/${id}`;
		const hit = known.get(key);
		if (hit !== undefined || asked.has(key)) return hit ?? '…';
		asked.add(key);
		Promise.resolve(bolt.get<Row | null>(target, id)).then(
			(r) => known.set(key, [catalog()?.[target]?.label ?? []].flat().map((l) => show(r?.[l] ?? null, bolt.locale)).filter(Boolean).join(' · ')
				|| msg(bolt, 'view.unnamed', 'an unnamed {what}', { what: label(bolt, target).toLowerCase() })),
			() => known.set(key, msg(bolt, 'view.unseen', 'a record you cannot see')));
		return '…';
	};
}
