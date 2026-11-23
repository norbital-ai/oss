// Single-tab-stop roving focus for horizontal strips, vertical lists, rails and 2D grids.
// Handles Arrow keys (RTL-aware), Home/End, loop wrap-around, disabled skipping and DOM focus recovery.
import type { Attachment } from 'svelte/attachments';

/** Arrow-key navigation axis (`'horizontal'`, `'vertical'`, or `'both'`). */
export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

/** Options for `create_roving_focus`. */
export type RovingFocusOptions = {
	/** Keys in navigation order. */
	items: () => readonly string[];
	/** Controlled active key; omit for internal focus tracking. */
	active?: () => string | undefined;
	/** Called when keyboard navigation moves focus to a key. */
	on_active_change?: (key: string) => void;
	/** Axis of arrow navigation (default `'horizontal'`). */
	orientation?: RovingOrientation | (() => RovingOrientation);
	/** Wrap from last back to first and vice versa (default `true`). */
	loop?: boolean;
	/** Skip disabled keys during keyboard movement. */
	disabled?: (key: string) => boolean;
	/** Optional callback invoked when Space or Enter activates the focused item. */
	on_activate?: (key: string) => void;
};

/** Return value of `create_roving_focus`. */
export type RovingFocus = ReturnType<typeof create_roving_focus>;

/**
 * Headless roving-tabindex focus manager. Keeps exactly one `tabindex="0"` in the group so
 * Tab enters/exits cleanly while arrow keys move between enabled items.
 */
export function create_roving_focus(options: RovingFocusOptions) {
	const nodes = new Map<string, HTMLElement>();
	let internal = $state<string | undefined>(undefined);

	const orientation = $derived(
		typeof options.orientation === 'function'
			? options.orientation()
			: (options.orientation ?? 'horizontal')
	);
	const isDisabled = (key: string) => options.disabled?.(key) ?? false;
	const enabled = $derived(options.items().filter((key) => !isDisabled(key)));

	const active = $derived.by(() => {
		const wanted = options.active ? options.active() : internal;
		if (wanted !== undefined && enabled.includes(wanted)) return wanted;
		return enabled[0];
	});

	function move(key: string): void {
		if (isDisabled(key)) return;
		if (!options.active) internal = key;
		options.on_active_change?.(key);
		nodes.get(key)?.focus({ preventScroll: false });
	}

	function step(delta: number): void {
		if (enabled.length === 0) return;
		const currentIndex = active !== undefined ? enabled.indexOf(active) : -1;
		const base = currentIndex < 0 ? 0 : currentIndex;
		const nextIndex =
			options.loop === false
				? Math.max(0, Math.min(enabled.length - 1, base + delta))
				: (base + delta + enabled.length) % enabled.length;
		const next = enabled[nextIndex];
		if (next !== undefined) move(next);
	}

	function handle_keydown(event: KeyboardEvent): void {
		const rtl =
			event.currentTarget instanceof HTMLElement &&
			getComputedStyle(event.currentTarget).direction === 'rtl';
		const prevH = rtl ? 'ArrowRight' : 'ArrowLeft';
		const nextH = rtl ? 'ArrowLeft' : 'ArrowRight';

		const allowH = orientation === 'horizontal' || orientation === 'both';
		const allowV = orientation === 'vertical' || orientation === 'both';

		if ((allowH && event.key === nextH) || (allowV && event.key === 'ArrowDown')) {
			event.preventDefault();
			step(1);
			return;
		}
		if ((allowH && event.key === prevH) || (allowV && event.key === 'ArrowUp')) {
			event.preventDefault();
			step(-1);
			return;
		}
		if (event.key === 'Home') {
			event.preventDefault();
			if (enabled[0] !== undefined) move(enabled[0]);
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			const last = enabled.at(-1);
			if (last !== undefined) move(last);
			return;
		}
		if ((event.key === 'Enter' || event.key === ' ') && active !== undefined && options.on_activate) {
			event.preventDefault();
			options.on_activate(active);
		}
	}

	return {
		get active() {
			return active;
		},
		focus(key: string) {
			move(key);
		},
		next() {
			step(1);
		},
		prev() {
			step(-1);
		},
		/** Attach to each focusable item so arrow navigation can call `.focus()` on it. */
		item(key: string): Attachment<HTMLElement> {
			return (el) => {
				nodes.set(key, el);
				return () => {
					if (nodes.get(key) === el) nodes.delete(key);
				};
			};
		},
		/** Spread onto the container element to handle arrow/Home/End keyboard navigation. */
		root_attrs() {
			return {
				onkeydown: handle_keydown
			};
		},
		/** Spread onto each item for roving `tabindex`, focus syncing and `data-focused` state. */
		item_attrs(key: string) {
			const disabled = isDisabled(key);
			const current = !disabled && active === key;
			return {
				tabindex: disabled ? undefined : current ? 0 : -1,
				'data-roving-active': current ? '' : undefined,
				onfocus: () => {
					if (!disabled && active !== key) {
						if (!options.active) internal = key;
						options.on_active_change?.(key);
					}
				}
			};
		}
	};
}
