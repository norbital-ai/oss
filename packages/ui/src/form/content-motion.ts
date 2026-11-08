/** Preserve continuity when a record section changes versions or receives new values. */
export function contentMotion(node: HTMLElement) {
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
	const active = new Set<Animation>();
	const play = (target: HTMLElement, frames: Keyframe[], duration = 220) => {
		if (reduced.matches || typeof target.animate !== 'function' || !target.isConnected) return;
		const animation = target.animate(frames, { duration, easing: 'cubic-bezier(.2,.8,.2,1)' });
		active.add(animation);
		void animation.finished.then(
			() => active.delete(animation),
			() => active.delete(animation)
		);
	};
	let observed = node.firstElementChild;
	// Height moves only in answer to the viewer (a disclosure toggled, a row added): content that arrives or grows on its
	// own (the first load, a late editor, a new revision) takes its height at once, never rolling out.
	let asked = -Infinity;
	const ask = () => (asked = performance.now());
	node.addEventListener('click', ask, true);
	node.addEventListener('toggle', ask, true);
	// the content's border box (its own padding included) plus the node's padding and border: the node's own height
	const outer = () => {
		const style = getComputedStyle(node);
		return (
			parseFloat(style.paddingTop) +
			parseFloat(style.paddingBottom) +
			parseFloat(style.borderTopWidth) +
			parseFloat(style.borderBottomWidth)
		);
	};
	let height = observed?.getBoundingClientRect().height ?? 0;
	const resize =
		typeof ResizeObserver === 'undefined' || node.matches('[data-view=record]')
			? null
			: new ResizeObserver(([entry]) => {
					if (!entry) return;
					const next =
						entry.borderBoxSize[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
					// a section's own open or close animates the body; this one would fight it
					if (
						performance.now() - asked < 400 &&
						height > 0 &&
						next > 0 &&
						Math.abs(next - height) > 1 &&
						!('moving' in node.dataset)
					) {
						const edge = outer();
						play(node, [
							{ height: `${height + edge}px`, overflow: 'clip' },
							{ height: `${next + edge}px`, overflow: 'clip' }
						]);
					}
					height = next;
				});
	if (observed) resize?.observe(observed);
	const structure = new MutationObserver(() => {
		const next = node.firstElementChild;
		if (next === observed) return;
		if (observed) resize?.unobserve(observed);
		observed = next;
		height = next?.getBoundingClientRect().height ?? 0;
		if (observed) resize?.observe(observed);
	});
	structure.observe(node, { childList: true });
	const cancel = () => {
		if (reduced.matches) for (const animation of active) animation.cancel();
	};
	reduced.addEventListener('change', cancel);
	return {
		destroy() {
			structure.disconnect();
			node.removeEventListener('click', ask, true);
			node.removeEventListener('toggle', ask, true);
			resize?.disconnect();
			reduced.removeEventListener('change', cancel);
			for (const animation of active) animation.cancel();
		}
	};
}
