/** Measure natural trigger widths so both page links and body tabs use the same overflow menu. */
export function observeTabOverflow(
	list: HTMLElement,
	measure: HTMLElement,
	onFit: (count: number) => void
): () => void {
	const layout = () => {
		const items = [...measure.children].filter((e): e is HTMLElement => e instanceof HTMLElement);
		const more = items.pop()?.offsetWidth ?? 0;
		const style = getComputedStyle(list);
		const gap = parseFloat(style.columnGap) || 0;
		const room =
			list.clientWidth -
			(parseFloat(style.paddingLeft) || 0) -
			(parseFloat(style.paddingRight) || 0);
		const widths = items.map((e) => e.offsetWidth);
		// not laid out yet (a hidden panel, a first paint): keep what is shown and wait for the observer
		if (room <= 0 || widths.length === 0 || widths.every((width) => width === 0)) return;
		if (
			widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1) <=
			room
		) {
			onFit(widths.length);
			return;
		}
		let used = more,
			count = 0;
		for (const width of widths) {
			if (used + gap + width > room) break;
			used += gap + width;
			count++;
		}
		onFit(count);
	};
	layout();
	const observer = new ResizeObserver(layout);
	observer.observe(list);
	observer.observe(measure);
	return () => observer.disconnect();
}
