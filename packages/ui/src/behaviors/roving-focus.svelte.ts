// Single-tab-stop roving focus for horizontal strips, vertical lists, rails and toolbars.
// Handles Arrow keys (RTL-aware), Home/End, loop wrap-around, disabled skipping and automatic
// DOM focus recovery when the focused item unmounts.
import type { Attachment } from 'svelte/attachments';
import { create_focus_recovery } from './focus-recovery.svelte.js';

/** Arrow-key navigation axis (`'horizontal'`, `'vertical'`, or `'both'`). */
export type RovingOrientation = 'horizontal' | 'vertical' | 'both';

/** Options for `create_roving_focus`. */
export type RovingFocusOptions = {
	/** Keys in navigation order. */
	readonly items: () => readonly string[];
	/** Controlled active key; omit for internal focus tracking. */
	readonly active?: () => string | undefined;
	/** Called when keyboard navigation moves focus to a key. */
	readonly on_active_change?: (key: string) => void;
	/** Axis of arrow navigation (default `'horizontal'`). */
	readonly orientation?: RovingOrientation | (() => RovingOrientation);
	/** Wrap from last back to first and vice versa (default `true`). */
	readonly loop?: boolean;
	/** Skip disabled keys during keyboard movement. */
	readonly disabled?: (key: string) => boolean;
	/** Optional callback invoked when Space or Enter activates the focused item. */
	readonly on_activate?: (key: string) => void;
};

/** Return value of `create_roving_focus`. */
export type RovingFocus = ReturnType<typeof create_roving_focus>;

/**
 * Headless roving-tabindex focus manager with automatic focus recovery when items leave the DOM.
 */
export function create_roving_focus(options: RovingFocusOptions) {
	const nodes = new Map<string, HTMLElement>();
	let internal = $state<string | undefined>(undefined);
	let lastOrder: readonly string[] = [];

	const orientation = $derived(
		typeof options.orientation === 'function'
			? options.orientation()
			: (options.orientation ?? 'horizontal')
	);
	const isDisabled = (key: string) => options.disabled?.(key) ?? false;
	const enabled = $derived(options.items().filter((key) => !isDisabled(key)));

	$effect(() => {
		lastOrder = [...options.items()];
	});

	const active = $derived.by(() => {
		const wanted = options.active ? options.active() : internal;
		if (wanted !== undefined && enabled.includes(wanted)) return wanted;
		return enabled[0];
	});

	const recovery = create_focus_recovery<undefined>({
		fallback: (lost) => {
			const remaining = enabled;
			if (remaining.length === 0) return null;
			const oldIndex = lastOrder.indexOf(lost.key);
			if (oldIndex >= 0) {
				for (let i = oldIndex + 1; i < lastOrder.length; i++) {
					const k = lastOrder[i];
					if (k !== undefined && remaining.includes(k)) return nodes.get(k) ?? null;
				}
				for (let i = oldIndex - 1; i >= 0; i--) {
					const k = lastOrder[i];
					if (k !== undefined && remaining.includes(k)) return nodes.get(k) ?? null;
				}
			}
			const first = remaining[0];
			return first !== undefined ? (nodes.get(first) ?? null) : null;
		}
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
		if (event.metaKey || event.ctrlKey || event.altKey) return;
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
		/** Attach to each focusable item for arrow focus & unmount focus recovery. */
		item(key: string): Attachment<HTMLElement> {
			const recover = recovery.item(key);
			return (el) => {
				nodes.set(key, el);
				const stopRecover = recover(el);
				return () => {
					stopRecover?.();
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
		/** Spread onto each item for roving `tabindex`, focus syncing and `data-roving-active` state. */
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
