/** Keep the shared access card continuous when its page or form step changes. */
export function accessHeight(content: HTMLElement) {
	const panel = content.parentElement;
	if (panel === null) return;
	const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
	let animation: Animation | undefined;
	const measure = () => {
		const style = getComputedStyle(panel);
		const natural =
			content.getBoundingClientRect().height +
			Number.parseFloat(style.borderTopWidth) +
			Number.parseFloat(style.borderBottomWidth);
		return Math.min(natural, Number.parseFloat(style.maxBlockSize) || natural);
	};
	let height = measure();
	const resize = () => {
		const next = measure();
		if (Math.abs(next - height) < 1) return;
		const from = animation ? panel.getBoundingClientRect().height : height;
		animation?.cancel();
		height = next;
		if (reduced.matches || typeof panel.animate !== 'function') return;
		animation = panel.animate([{ height: `${from}px` }, { height: `${next}px` }], {
			duration: 240,
			easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
		});
	};
	const observer = new ResizeObserver(resize);
	observer.observe(content);
	const motionChanged = () => {
		if (reduced.matches) animation?.cancel();
	};
	reduced.addEventListener('change', motionChanged);
	window.addEventListener('resize', resize);
	return () => {
		observer.disconnect();
		reduced.removeEventListener('change', motionChanged);
		window.removeEventListener('resize', resize);
		animation?.cancel();
	};
}
