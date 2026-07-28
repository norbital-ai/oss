function clamp(n: number, min: number, max: number) {
	return Math.max(min, Math.min(n, max));
}

export function estimateContentWidth(
	anchorWidth: number,
	opts: {
		sameWidth?: boolean;
		minWidth?: number;
		maxWidth?: number;
	}
): number {
	if (opts.sameWidth) {
		if (opts.minWidth && opts.maxWidth) return clamp(anchorWidth, opts.minWidth, opts.maxWidth);
		if (opts.minWidth && !opts.maxWidth) return Math.max(opts.minWidth, anchorWidth);
		if (!opts.minWidth && opts.maxWidth) return Math.min(anchorWidth, opts.maxWidth);
		return anchorWidth;
	}
	if (opts.minWidth && opts.maxWidth) return clamp(opts.minWidth, opts.minWidth, opts.maxWidth);
	if (opts.minWidth && !opts.maxWidth) return opts.minWidth;
	if (!opts.minWidth && opts.maxWidth) return Math.min(anchorWidth, opts.maxWidth);
	return anchorWidth;
}

export function doesAlignFit(
	al: 'start' | 'center' | 'end',
	rect: DOMRect,
	width: number,
	viewportWidth: number
): boolean {
	if (al === 'start') {
		const left = rect.left;
		const right = rect.left + width;
		return left >= 0 && right <= viewportWidth;
	}
	if (al === 'end') {
		const left = rect.right - width;
		const right = rect.right;
		return left >= 0 && right <= viewportWidth;
	}
	const center = rect.left + rect.width / 2;
	const left = center - width / 2;
	const right = center + width / 2;
	return left >= 0 && right <= viewportWidth;
}

export function pickSnappedAlign(
	triggerEl: HTMLElement | null,
	preferred: 'start' | 'center' | 'end',
	estimateContentWidth: (anchorWidth: number) => number
): 'start' | 'center' | 'end' {
	if (!triggerEl) return preferred;
	if (typeof window === 'undefined') return preferred;
	const rect = triggerEl.getBoundingClientRect();
	const estWidth = estimateContentWidth(rect.width);
	const vw = window.innerWidth || 0;
	if (doesAlignFit(preferred, rect, estWidth, vw)) return preferred;
	if (preferred === 'center') {
		const spaceLeft = rect.left;
		const spaceRight = vw - rect.right;
		if (doesAlignFit('end', rect, estWidth, vw) && spaceRight >= spaceLeft) return 'end';
		if (doesAlignFit('start', rect, estWidth, vw)) return 'start';
		return 'center';
	}
	if (preferred === 'start') {
		if (doesAlignFit('end', rect, estWidth, vw)) return 'end';
		return 'start';
	}
	if (doesAlignFit('start', rect, estWidth, vw)) return 'start';
	return 'end';
}
