// Focus recovery for dynamic lists, trees, tabs and chips: when the element holding focus is
// removed from the DOM (deleted row, collapsed branch, cleared chip, filtered item), focus moves
// to a chosen neighbor instead of falling to `document.body`.
import type { Attachment } from 'svelte/attachments';

/** Info about a bound element that left the DOM while holding focus. */
export type LostFocus<T = unknown> = {
	/** Stable key of the removed item. */
	readonly key: string;
	/** Optional caller metadata attached to the item. */
	readonly data: T | undefined;
	/** The removed DOM element. */
	readonly element: HTMLElement;
};

/** Options for `create_focus_recovery`. */
export type FocusRecoveryOptions<T = unknown> = {
	/** Returns the next element to focus when a bound item unmounts with focus, or null/undefined. */
	readonly fallback: (lost: LostFocus<T>) => HTMLElement | null | undefined;
};

/** Return value of `create_focus_recovery`. */
export type FocusRecovery<T = unknown> = ReturnType<typeof create_focus_recovery<T>>;

/**
 * Tracks focus across dynamically mounted items (`{@attach recovery.item(key, data)}`). When the
 * currently focused item unmounts, `fallback` runs after removal settles and restores keyboard focus.
 */
export function create_focus_recovery<T = undefined>(options: FocusRecoveryOptions<T>) {
	const bound = new WeakSet<Element>();
	let holder: HTMLElement | null = null;

	function innermost(node: EventTarget | null): HTMLElement | null {
		let cur = node instanceof Element ? node : null;
		while (cur !== null) {
			if (bound.has(cur) && cur instanceof HTMLElement) return cur;
			cur = cur.parentElement;
		}
		return null;
	}

	function item(key: string, data?: T): Attachment<HTMLElement> {
		return (el) => {
			bound.add(el);
			const onFocusin = (event: FocusEvent) => {
				if (innermost(event.target) === el) holder = el;
			};
			const onFocusout = () => {
				queueMicrotask(() => {
					if (holder === el && el.isConnected && !el.contains(document.activeElement)) {
						holder = null;
					}
				});
			};

			el.addEventListener('focusin', onFocusin);
			el.addEventListener('focusout', onFocusout);

			return () => {
				el.removeEventListener('focusin', onFocusin);
				el.removeEventListener('focusout', onFocusout);
				bound.delete(el);

				const active = typeof document === 'undefined' ? null : document.activeElement;
				const held =
					el.contains(active) ||
					(holder === el && (active === null || active === document.body || active === document.documentElement));
				if (holder === el) holder = null;
				if (!held) return;

				const lost: LostFocus<T> = { key, data, element: el };
				queueMicrotask(() => {
					if (typeof document === 'undefined') return;
					const now = document.activeElement;
					// Respect focus if something else already moved it intentionally.
					if (now !== null && now !== document.body && now !== document.documentElement && now.isConnected) {
						return;
					}
					const next = options.fallback(lost);
					if (next !== null && next !== undefined && next.isConnected) {
						next.focus({ preventScroll: true });
					}
				});
			};
		};
	}

	return { item };
}
