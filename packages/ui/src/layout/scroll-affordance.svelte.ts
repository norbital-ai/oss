/**
 * The overflow state a scrollport publishes for `base.css` to style it.
 *
 * `data-overflow` lists the edges that have content past them, so the edge fade appears
 * only where there is genuinely more to reach. Scrollbar visibility is CSS hover state;
 * it deliberately is not persisted after keyboard or programmatic scrolling.
 *
 * Both are attributes rather than reactive state because the styling lives entirely in
 * CSS: nothing in Svelte reads them back, so a re-render per scroll frame would buy
 * nothing. The write is guarded on change for the same reason — a scroll event fires per
 * frame and only the first one in a run actually alters the attribute.
 */
type Edge = 'block-start' | 'block-end' | 'inline-start' | 'inline-end';

function overflowEdges(node: HTMLElement): string {
	const edges: Edge[] = [];
	// `scrollLeft` is negative in a right-to-left scrollport, so the *distance* to each
	// end is what decides the edge, never the sign of the offset.
	const top = node.scrollTop;
	const bottom = node.scrollHeight - node.clientHeight - top;
	const left = Math.abs(node.scrollLeft);
	const right = node.scrollWidth - node.clientWidth - left;

	// A sub-pixel remainder is what a fractional layout leaves behind at a true end; a
	// fade drawn for it would never switch off.
	if (top > 1) edges.push('block-start');
	if (bottom > 1) edges.push('block-end');
	if (left > 1) edges.push('inline-start');
	if (right > 1) edges.push('inline-end');
	return edges.join(' ');
}

/**
 * Publish scroll position as attributes on a scrollport.
 *
 * ```svelte
 * <div class="overflow-y-auto" {@attach scrollAffordance()}>…</div>
 * ```
 *
 * `<Scroll>` applies it already; reach for it directly only on a scrollport that cannot
 * be one, such as a component's internal rail.
 *
 * `fade: false` drops the edge attribute for a region whose content must stay opaque to
 * its own edge. Its scrollbar still follows the global hover-only rule.
 */
export function scrollAffordance(options?: { fade?: boolean }) {
	const fade = options?.fade ?? true;

	return (node: HTMLElement) => {
		const syncOverflow = () => {
			if (!fade) return;
			const edges = overflowEdges(node);
			if (node.getAttribute('data-overflow') !== edges) {
				node.setAttribute('data-overflow', edges);
			}
		};

		const onScroll = () => {
			syncOverflow();
		};

		// Content arriving or the pane resizing changes what overflows without any scroll
		// event at all — a filtered list that drops below the fold is the common case.
		const observer = new ResizeObserver(syncOverflow);
		observer.observe(node);
		for (const child of node.children) observer.observe(child);

		const mutations = new MutationObserver(() => {
			for (const child of node.children) observer.observe(child);
			syncOverflow();
		});
		mutations.observe(node, { childList: true, subtree: true, characterData: true });

		node.addEventListener('scroll', onScroll, { passive: true });
		syncOverflow();

		return () => {
			observer.disconnect();
			mutations.disconnect();
			node.removeEventListener('scroll', onScroll);
		};
	};
}
