// Smart tail-latching scroll behavior for chat transcripts, agent streams and live log feeds.
// Automatically keeps the viewport pinned to the latest item while the user is near the bottom,
// releases when they scroll up to read history, and exposes `scroll_to_bottom()` to re-latch.
import type { Attachment } from 'svelte/attachments';

/** Options for `create_stick_to_bottom`. */
export type StickToBottomOptions = {
	/** Pixel distance from the bottom edge still considered latched (default `32`). */
	threshold?: number;
	/** Start latched to the bottom (default `true`). */
	initial?: boolean;
};

/** Return value of `create_stick_to_bottom`. */
export type StickToBottom = ReturnType<typeof create_stick_to_bottom>;

/**
 * Headless tail-latching scroll attachment (`{@attach tail.viewport}`).
 */
export function create_stick_to_bottom(options: StickToBottomOptions = {}) {
	const threshold = options.threshold ?? 32;
	let viewportEl: HTMLElement | null = null;
	let stuck = $state(options.initial ?? true);

	function measure(): boolean {
		if (viewportEl === null) return true;
		const distance = viewportEl.scrollHeight - viewportEl.scrollTop - viewportEl.clientHeight;
		return distance <= threshold;
	}

	function scroll_to_bottom(behavior: ScrollBehavior = 'auto'): void {
		stuck = true;
		if (viewportEl === null) return;
		if (typeof viewportEl.scrollTo === 'function') {
			viewportEl.scrollTo({ top: viewportEl.scrollHeight, behavior });
		} else {
			viewportEl.scrollTop = viewportEl.scrollHeight;
		}
	}

	const viewport: Attachment<HTMLElement> = (el) => {
		viewportEl = el;
		if (stuck) scroll_to_bottom('auto');

		const onScroll = () => {
			stuck = measure();
		};
		el.addEventListener('scroll', onScroll, { passive: true });

		const mo =
			typeof MutationObserver === 'undefined'
				? null
				: new MutationObserver(() => {
						if (stuck) scroll_to_bottom('auto');
					});
		mo?.observe(el, { childList: true, subtree: true, characterData: true });

		const ro =
			typeof ResizeObserver === 'undefined'
				? null
				: new ResizeObserver(() => {
						if (stuck) scroll_to_bottom('auto');
					});
		ro?.observe(el);

		return () => {
			el.removeEventListener('scroll', onScroll);
			mo?.disconnect();
			ro?.disconnect();
			if (viewportEl === el) viewportEl = null;
		};
	};

	return {
		get stuck() {
			return stuck;
		},
		scroll_to_bottom,
		viewport
	};
}
