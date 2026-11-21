/**
 * The overflow state a scrollport publishes for `base.css` to style it.
 *
 * `data-overflow` lists the edges that have content past them, so the edge fade appears
 * only where there is genuinely more to reach. Scrollbar visibility is CSS hover state;
 * it deliberately is not persisted after keyboard or programmatic scrolling.
 *
 * The edge list is an attribute rather than reactive state because the styling lives entirely in
 * CSS: nothing in Svelte reads them back, so a re-render per scroll frame would buy
 * nothing. The write is guarded on change for the same reason — a scroll event fires per
 * frame and only the first one in a run actually alters the attribute.
 */
type Edge = 'block-start' | 'block-end' | 'inline-start' | 'inline-end';

function overflowEdges(node: HTMLElement): string {
	const edges: Edge[] = [];
	// `scrollLeft` is negative in RTL and `scrollTop` is negative in `flex-direction: column-reverse`
	// (such as Firefox/Gecko chat scrollports), so measure distance from both ends regardless of sign.
	const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
	const rawTop = node.scrollTop;
	const reversed = rawTop < 0 || getComputedStyle(node).flexDirection === 'column-reverse';
	const top = reversed ? Math.max(0, maxTop + rawTop) : rawTop;
	const bottom = reversed ? Math.max(0, -rawTop) : Math.max(0, maxTop - rawTop);
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
 * The edges also decide `overscroll-behavior`: `base.css` contains chaining only on an edge
 * with content past it, because Chrome stops the chain at every contain'ed scroll container,
 * scrollable or not, and an inert region would otherwise trap the wheel meant for its ancestor.
 *
 * `fade: false` keeps the edges but stamps `data-fade="false"` so the mask stays off for a
 * region whose content must stay opaque to its own edge. Its scrollbar still follows the
 * global hover-only rule.
 */
export function scrollAffordance(options?: { fade?: boolean }) {
	const fade = options?.fade ?? true;

	return (node: HTMLElement) => {
		if (!fade) node.setAttribute('data-fade', 'false');
		const syncOverflow = () => {
			const edges = overflowEdges(node);
			if (node.getAttribute('data-overflow') !== edges) {
				node.setAttribute('data-overflow', edges);
			}
		};

		let frame = 0;
		const schedule = () => {
			if (frame === 0)
				frame = requestAnimationFrame(() => {
					frame = 0;
					syncOverflow();
				});
		};

		// Content arriving or the pane resizing changes what overflows without any scroll
		// event at all — a filtered list that drops below the fold is the common case.
		// Observe direct children via ResizeObserver (which catches nested height changes) and
		// coalesce onto one animation frame instead of forcing synchronous reflow per character mutation.
		const observer = new ResizeObserver(schedule);
		observer.observe(node);
		for (const child of node.children) observer.observe(child);

		const mutations = new MutationObserver(() => {
			for (const child of node.children) observer.observe(child);
			schedule();
		});
		mutations.observe(node, { childList: true });

		node.addEventListener('scroll', schedule, { passive: true });
		syncOverflow();

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			mutations.disconnect();
			node.removeEventListener('scroll', schedule);
		};
	};
}
