import { recordText } from '../kinds/kind.js';
import { Effect } from 'effect';
import { fork } from '../effect/index.js';
import { SvelteMap } from 'svelte/reactivity';
import type { ModelExposure } from '../kinds/context.js';
import { by_id, first_of } from '../read/request.js';
import type { ViewBolt } from '../client/contract.js';
import { label, msg } from '../text/messages.js';
import { label_read } from '../relations/select.js';
/**
 * A relation value's words (a filter chip, the author's scope): the record's declared label, read once per record; "…"
 * while it loads. Without a label use the id; a record the viewer cannot read says so.
 */
export function record_labels(
	bolt: Pick<ViewBolt, 'query' | 't' | 'locale'>,
	catalog: () => { readonly [c: string]: ModelExposure } | undefined
) {
	const known = new SvelteMap<string, string>();
	const asked = new Set<string>();
	return (target: string, id: string): string => {
		const key = `${target}/${id}`;
		const hit = known.get(key);
		if (hit !== undefined || asked.has(key)) return hit ?? '…';
		asked.add(key);
		fork(
			bolt
				.query(
					catalog()?.[target]?.record_label !== undefined
						? label_read(catalog(), target, { where: { id: { eq: id } }, limit: 1 })
						: by_id(target, id)
				)
				.pipe(
					Effect.map((answer) => first_of(answer, target)),
					Effect.tap((row) =>
						Effect.sync(() =>
							known.set(
								key,
								recordText(catalog()?.[target], row ?? {}) ||
									msg(bolt, 'view.unnamed', {
										what: label(bolt, target).toLowerCase()
									})
							)
						)
					),
					Effect.catch(() =>
						Effect.sync(() => known.set(key, msg(bolt, 'view.unseen')))
					)
				)
		);
		return '…';
	};
}
