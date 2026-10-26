/** Prefer a field edge before the floating library clamps an oversized panel to the viewport. */
export function popoverAlignment(
	field: Pick<DOMRect, 'left' | 'right'>,
	width: number,
	viewport: number,
	padding = 8
): 'start' | 'end' {
	const startFits = field.left >= padding && field.left + width <= viewport - padding;
	const endFits = field.right - width >= padding && field.right <= viewport - padding;
	return !startFits && endFits ? 'end' : 'start';
}

/** Date controls anchor their calendar to the full field, including a segmented range's two inputs. */
export function fieldPopoverAlignment(
	anchor: () => HTMLElement | null,
	content: () => HTMLElement | null,
	padding: () => number
) {
	let align = $state<'start' | 'end'>('start');
	$effect(() => {
		const field = anchor();
		const panel = content();
		const inset = padding();
		if (field === null || panel === null) return;
		let frame = 0;
		const update = () => {
			align = popoverAlignment(
				field.getBoundingClientRect(),
				panel.offsetWidth,
				document.documentElement.clientWidth,
				inset
			);
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(update);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(field);
		observer.observe(panel);
		window.addEventListener('resize', schedule);
		window.addEventListener('scroll', schedule, true);
		update();
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener('resize', schedule);
			window.removeEventListener('scroll', schedule, true);
		};
	});
	return {
		get current() {
			return align;
		}
	};
}
