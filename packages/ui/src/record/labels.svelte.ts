import { formatValue as show } from '../kinds/kind.js';
import { Effect } from 'effect';
import { fork } from '../effect/index.js';
import { SvelteMap } from 'svelte/reactivity';
import type { CollectionExposure } from '../kinds/context.js';
import type { Row } from '../collection/types.js';
import type { ViewBolt } from '../client/contract.js';
import { label, msg } from '../text/messages.js';
/**
 * A relation value's words (a filter chip, the author's scope): the record's declared label, read once per record; "…"
 * while it loads. Never the id: a record the viewer cannot read says so.
 */
export function recordLabels(
	bolt: Pick<ViewBolt, 'query' | 't' | 'locale'>,
	catalog: () => { readonly [c: string]: CollectionExposure } | undefined
) {
	const known = new SvelteMap<string, string>();
	const asked = new Set<string>();
	return (target: string, id: string): string => {
		const key = `${target}/${id}`;
		const hit = known.get(key);
		if (hit !== undefined || asked.has(key)) return hit ?? '…';
		asked.add(key);
		fork(
			bolt.query<Row | null>(target, { id }).pipe(
				Effect.tap((row) =>
					Effect.sync(() =>
						known.set(
							key,
							[catalog()?.[target]?.label ?? []]
								.flat()
								.map((field) => show(row?.[field] ?? null, bolt.locale))
								.filter(Boolean)
								.join(' · ') ||
								msg(bolt, 'view.unnamed', 'an unnamed {what}', {
									what: label(bolt, target).toLowerCase()
								})
						)
					)
				),
				Effect.catch(() =>
					Effect.sync(() => known.set(key, msg(bolt, 'view.unseen', 'a record you cannot see')))
				)
			)
		);
		return '…';
	};
}
