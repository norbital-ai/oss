// Anchor-relative floating positioning with automatic viewport flip, edge shift clamping,
// scroll/resize tracking and optional LIFO dismissal — powers Popover, Tooltip and menus directly
// with z-50 owned from frame 1 (no body-wrapper flash or external floating-ui runtime).
import type { Attachment } from 'svelte/attachments';
import { create_dismiss, type DismissReason } from './dismiss.svelte.js';

/** Preferred side of the anchor where the floating surface opens. */
export type FloatingSide = 'top' | 'bottom' | 'left' | 'right';
/** Cross-axis alignment relative to the anchor edge. */
export type FloatingAlign = 'start' | 'center' | 'end';

/** Options for `create_floating`. */
export type FloatingOptions = {
	/** Whether the floating surface is open. */
	readonly open: () => boolean;
	/** Called when Escape or an outside pointer press dismisses the surface. */
	readonly on_dismiss?: (reason: DismissReason) => void;
	/** Optional reactive anchor element getter (avoids a second effect pass when anchor is a prop). */
	readonly anchor?: () => HTMLElement | null;
	/** Preferred side relative to the anchor (default `'bottom'`). */
	readonly side?: FloatingSide | (() => FloatingSide);
	/** Cross-axis alignment relative to the anchor (default `'center'`). */
	readonly align?: FloatingAlign | (() => FloatingAlign);
	/** Gap between anchor and floating surface in px (default `4`). */
	readonly side_offset?: number | (() => number);
	/** Shift along the cross axis in px (default `0`). */
	readonly align_offset?: number | (() => number);
	/** Viewport edge padding in px (default `8`). */
	readonly padding?: number | (() => number);
	/** Flip to the opposite side when viewport room is insufficient (default `true`). */
	readonly flip?: boolean | (() => boolean);
	/** Close on Escape key (default `true`). */
	readonly escape?: boolean | (() => boolean);
	/** Close on outside pointer press (default `true`). */
	readonly outside?: boolean | (() => boolean);
};

/** Return value of `create_floating`. */
export type Floating = ReturnType<typeof create_floating>;

function opposite(side: FloatingSide): FloatingSide {
	switch (side) {
		case 'top':
			return 'bottom';
		case 'bottom':
			return 'top';
		case 'left':
			return 'right';
		case 'right':
			return 'left';
	}
}

function computeCoords(
	anchor: DOMRect,
	content: { width: number; height: number },
	side: FloatingSide,
	align: FloatingAlign,
	sideOffset: number,
	alignOffset: number
): { x: number; y: number } {
	let x = 0;
	let y = 0;
	if (side === 'top' || side === 'bottom') {
		y = side === 'bottom' ? anchor.bottom + sideOffset : anchor.top - content.height - sideOffset;
		if (align === 'start') x = anchor.left + alignOffset;
		else if (align === 'end') x = anchor.right - content.width + alignOffset;
		else x = anchor.left + (anchor.width - content.width) / 2 + alignOffset;
	} else {
		x = side === 'right' ? anchor.right + sideOffset : anchor.left - content.width - sideOffset;
		if (align === 'start') y = anchor.top + alignOffset;
		else if (align === 'end') y = anchor.bottom - content.height + alignOffset;
		else y = anchor.top + (anchor.height - content.height) / 2 + alignOffset;
	}
	return { x, y };
}

/**
 * Headless anchor-relative floating behavior with flip/shift collision avoidance and LIFO dismiss.
 * @example
 * let open = $state(false);
 * const floating = create_floating({ open: () => open, on_dismiss: () => (open = false) });
 * // <button {@attach floating.anchor} onclick={() => (open = !open)}>Filter</button>
 * // {#if open}
 * //   <div {@attach portal()} {@attach floating.content} style={floating.style}>...</div>
 * // {/if}
 */
export function create_floating(options: FloatingOptions) {
	let anchorEl = $state<HTMLElement | null>(null);
	let contentEl = $state<HTMLElement | null>(null);
	let x = $state(0);
	let y = $state(0);
	let actualSide = $state<FloatingSide | null>(null);
	let anchorWidth = $state(0);
	let originX = $state('50%');
	let originY = $state('50%');
	let positioned = $state(false);

	const resolvedAnchor = () => options.anchor?.() ?? anchorEl;
	const preferredSide = () =>
		typeof options.side === 'function' ? options.side() : (options.side ?? 'bottom');
	const preferredAlign = () =>
		typeof options.align === 'function' ? options.align() : (options.align ?? 'center');
	const sideOffsetOf = () =>
		typeof options.side_offset === 'function'
			? options.side_offset()
			: (options.side_offset ?? 4);
	const alignOffsetOf = () =>
		typeof options.align_offset === 'function'
			? options.align_offset()
			: (options.align_offset ?? 0);
	const padOf = () =>
		typeof options.padding === 'function' ? options.padding() : (options.padding ?? 8);
	const flipOf = () =>
		typeof options.flip === 'function' ? options.flip() : options.flip !== false;

	const dismiss = create_dismiss({
		open: options.open,
		on_dismiss: (reason) => options.on_dismiss?.(reason),
		escape: options.escape ?? true,
		outside: options.outside ?? true,
		ignore: () => [resolvedAnchor()]
	});

	function update(): void {
		const anchorNode = resolvedAnchor();
		if (anchorNode === null || contentEl === null || typeof window === 'undefined') return;
		const aRect = anchorNode.getBoundingClientRect();
		const vw = document.documentElement.clientWidth || window.innerWidth || 1024;
		const vh = document.documentElement.clientHeight || window.innerHeight || 768;
		// Measure untransformed layout dimensions first (`offsetWidth`/`offsetHeight`) so CSS
		// scale/translate enter animations never shrink the box and trigger mid-flight jumps or
		// right-edge re-wrap loops. Fall back to bounding rects for synthetic DOMs (offset* === 0).
		let width = contentEl.offsetWidth;
		let height = contentEl.offsetHeight;
		if (width === 0 || height === 0) {
			const cRect = contentEl.getBoundingClientRect();
			const childRect =
				cRect.width === 0 || cRect.height === 0
					? contentEl.firstElementChild?.getBoundingClientRect()
					: undefined;
			if (width === 0) width = cRect.width || childRect?.width || contentEl.scrollWidth || 0;
			if (height === 0) height = cRect.height || childRect?.height || contentEl.scrollHeight || 0;
		}

		anchorWidth = aRect.width;
		let side = preferredSide();
		const align = preferredAlign();
		const sOff = sideOffsetOf();
		const aOff = alignOffsetOf();
		const pad = padOf();

		let pos = computeCoords(aRect, { width, height }, side, align, sOff, aOff);
		if (flipOf()) {
			const overflows =
				(side === 'bottom' &&
					pos.y + height > vh - pad &&
					(aRect.top - height - sOff >= pad || aRect.top > vh - aRect.bottom)) ||
				(side === 'top' &&
					pos.y < pad &&
					(aRect.bottom + height + sOff <= vh - pad || vh - aRect.bottom > aRect.top)) ||
				(side === 'right' &&
					pos.x + width > vw - pad &&
					(aRect.left - width - sOff >= pad || aRect.left > vw - aRect.right)) ||
				(side === 'left' &&
					pos.x < pad &&
					(aRect.right + width + sOff <= vw - pad || vw - aRect.right > aRect.left));
			if (overflows) {
				side = opposite(side);
				pos = computeCoords(aRect, { width, height }, side, align, sOff, aOff);
			}
		}

		const nextX = Math.round(Math.max(pad, Math.min(pos.x, Math.max(pad, vw - width - pad))));
		const nextY = Math.round(Math.max(pad, Math.min(pos.y, Math.max(pad, vh - height - pad))));
		const anchorCenterX = aRect.left + aRect.width / 2;
		const anchorCenterY = aRect.top + aRect.height / 2;
		if (side === 'top' || side === 'bottom') {
			originX =
				width > 0 ? `${Math.round(Math.max(0, Math.min(width, anchorCenterX - nextX)))}px` : '50%';
			originY = side === 'top' ? '100%' : '0%';
		} else {
			originX = side === 'left' ? '100%' : '0%';
			originY =
				height > 0
					? `${Math.round(Math.max(0, Math.min(height, anchorCenterY - nextY)))}px`
					: '50%';
		}

		x = nextX;
		y = nextY;
		actualSide = side;
		positioned = true;
	}

	$effect(() => {
		const anchorNode = resolvedAnchor();
		if (!options.open() || anchorNode === null || contentEl === null) {
			positioned = false;
			x = 0;
			y = 0;
			actualSide = null;
			return;
		}
		update();
		let raf = 0;
		const schedule = () => {
			if (raf === 0 && typeof requestAnimationFrame === 'function') {
				raf = requestAnimationFrame(() => {
					raf = 0;
					update();
				});
			}
		};
		schedule();
		const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
		ro?.observe(anchorNode);
		ro?.observe(contentEl);
		window.addEventListener('resize', schedule, { passive: true });
		document.addEventListener('scroll', schedule, { capture: true, passive: true });
		return () => {
			if (raf !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
			ro?.disconnect();
			window.removeEventListener('resize', schedule);
			document.removeEventListener('scroll', schedule, { capture: true });
		};
	});

	const anchor: Attachment<HTMLElement> = (el) => {
		anchorEl = el;
		return () => {
			if (anchorEl === el) anchorEl = null;
		};
	};

	const content: Attachment<HTMLElement> = (el) => {
		contentEl = el;
		const stopDismiss = dismiss.surface(el);
		return () => {
			stopDismiss?.();
			if (contentEl === el) contentEl = null;
		};
	};

	return {
		get x() {
			return x;
		},
		get y() {
			return y;
		},
		get side() {
			return actualSide ?? preferredSide();
		},
		get anchor_width() {
			return anchorWidth;
		},
		get positioned() {
			return positioned;
		},
		get style() {
			return positioned
				? `position:fixed;left:${x}px;top:${y}px;z-index:50;--anchor-width:${anchorWidth}px;--floating-origin-x:${originX};--floating-origin-y:${originY};`
				: `position:fixed;left:0px;top:0px;z-index:50;--anchor-width:${anchorWidth}px;opacity:0;pointer-events:none;`;
		},
		/** Sets a programmatic virtual/explicit anchor element (e.g. for context menus or slash commands). */
		set_anchor(el: HTMLElement | null) {
			anchorEl = el;
		},
		update,
		anchor,
		content
	};
}
