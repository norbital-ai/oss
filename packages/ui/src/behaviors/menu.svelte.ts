// Composable WAI-ARIA Menu & ContextMenu behavior: `role="menu"` with ArrowUp/Down, Home/End,
// incremental typeahead, checkbox/radio items, `{ x, y }` context-menu virtual anchor, LIFO dismiss,
// focus restoration and live agent control registration.
import type { Attachment } from 'svelte/attachments';
import { register_control } from './controls.svelte.js';
import { create_floating, type FloatingAlign, type FloatingSide, type VirtualAnchor } from './floating.svelte.js';
import { create_roving_focus } from './roving-focus.svelte.js';
import { create_typeahead } from './typeahead.svelte.js';

let nextMenuId = 0;

/** One menu item descriptor for `create_menu`. */
export type MenuItem = {
	readonly id: string;
	readonly label: string;
	readonly disabled?: boolean;
	readonly role?: 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';
	readonly checked?: boolean;
	readonly on_select?: () => void;
};

/** Options for `create_menu`. */
export type MenuOptions<T extends MenuItem = MenuItem> = {
	/** Ordered menu items. */
	readonly items: () => readonly T[];
	/** Controlled open state; omit for internal state. */
	readonly open?: () => boolean;
	/** Called when open state changes. */
	readonly on_open_change?: (open: boolean) => void;
	/** Called when any enabled menu item is activated. */
	readonly on_select?: (item: T) => void;
	/** Close the menu after selecting a regular `menuitem` (default `true`). */
	readonly close_on_select?: boolean;
	/** Preferred side relative to trigger (default `'bottom'`). */
	readonly side?: FloatingSide;
	/** Cross-axis alignment relative to trigger (default `'start'`). */
	readonly align?: FloatingAlign;
	/** Accessible name for the menu. */
	readonly label?: string;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_menu`. */
export type Menu<T extends MenuItem = MenuItem> = ReturnType<typeof create_menu<T>>;

/**
 * Headless WAI-ARIA menu & context-menu behavior built on `create_floating`, `create_roving_focus`
 * and `create_typeahead`.
 */
export function create_menu<T extends MenuItem = MenuItem>(options: MenuOptions<T>) {
	const uid = `nb-menu-${++nextMenuId}`;
	const menuId = `${uid}-list`;
	let internalOpen = $state(false);
	let triggerEl: HTMLElement | null = null;
	let pointAnchor = $state<VirtualAnchor | null>(null);

	const open = $derived(options.open ? options.open() : internalOpen);
	const items = $derived(options.items());
	const ids = $derived(items.map((item) => item.id));
	const byId = $derived(new Map(items.map((item) => [item.id, item])));
	const isDisabled = (id: string) => byId.get(id)?.disabled === true;

	function setOpen(next: boolean, restoreFocus = false): void {
		if (next === open) return;
		if (!options.open) internalOpen = next;
		if (!next) pointAnchor = null;
		options.on_open_change?.(next);
		if (!next && restoreFocus && triggerEl !== null && triggerEl.isConnected) {
			triggerEl.focus({ preventScroll: true });
		}
	}

	function activate(id: string): void {
		const item = byId.get(id);
		if (item === undefined || item.disabled) return;
		item.on_select?.();
		options.on_select?.(item);
		if (options.close_on_select !== false && (item.role ?? 'menuitem') === 'menuitem') {
			setOpen(false, true);
		}
	}

	const roving = create_roving_focus({
		items: () => ids,
		orientation: 'vertical',
		disabled: isDisabled,
		on_activate: activate
	});

	const typeahead = create_typeahead({
		items: () => items.map((item) => ({ key: item.id, text: item.label, disabled: item.disabled })),
		active: () => roving.active,
		on_match: (id) => roving.focus(id)
	});

	const floating = create_floating({
		open: () => open,
		anchor: () => pointAnchor ?? triggerEl,
		side: options.side ?? 'bottom',
		align: options.align ?? 'start',
		on_dismiss: (reason) => setOpen(false, reason === 'escape')
	});

	function open_at(point: { x: number; y: number }): void {
		pointAnchor = point;
		setOpen(true);
		queueMicrotask(() => {
			const first = items.find((item) => !item.disabled);
			if (first !== undefined) roving.focus(first.id);
		});
	}

	function open_from_trigger(focusEdge: 'first' | 'last' = 'first'): void {
		pointAnchor = null;
		setOpen(true);
		queueMicrotask(() => {
			const enabled = items.filter((item) => !item.disabled);
			const target = focusEdge === 'last' ? enabled.at(-1) : enabled[0];
			if (target !== undefined) roving.focus(target.id);
		});
	}

	function handleMenuKeydown(event: KeyboardEvent): void {
		if (event.key === 'Tab') {
			setOpen(false, false);
			return;
		}
		roving.root_attrs().onkeydown(event);
		if (!event.defaultPrevented) typeahead.onkeydown(event);
	}

	function handleTriggerKeydown(event: KeyboardEvent): void {
		if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			open_from_trigger('first');
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			open_from_trigger('last');
		}
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'menu',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ open, items: items.map((item) => item.label) }),
				items: () => items.filter((item) => !item.disabled).map((item) => ({ value: item.id, label: item.label })),
				actions: {
					open: () => open_from_trigger('first'),
					close: () => setOpen(false),
					select: (wanted) => {
						if (typeof wanted !== 'string') return;
						const match = items.find((item) => item.id === wanted || item.label === wanted);
						if (match !== undefined) activate(match.id);
					}
				}
			})
		);
	}

	const trigger: Attachment<HTMLElement> = (el) => {
		triggerEl = el;
		const stopAnchor = floating.anchor(el);
		return () => {
			stopAnchor?.();
			if (triggerEl === el) triggerEl = null;
		};
	};

	const context_area: Attachment<HTMLElement> = (el) => {
		const onContext = (event: MouseEvent) => {
			event.preventDefault();
			open_at({ x: event.clientX, y: event.clientY });
		};
		el.addEventListener('contextmenu', onContext);
		return () => el.removeEventListener('contextmenu', onContext);
	};

	return {
		get open() {
			return open;
		},
		get active() {
			return roving.active;
		},
		get floating() {
			return floating;
		},
		open_at,
		open_menu: () => open_from_trigger('first'),
		close: () => setOpen(false, true),
		toggle: () => (open ? setOpen(false, true) : open_from_trigger('first')),
		trigger,
		content: floating.content,
		context_area,
		item: roving.item,
		trigger_attrs() {
			return {
				type: 'button' as const,
				'aria-haspopup': 'menu' as const,
				'aria-expanded': open,
				'aria-controls': open ? menuId : undefined,
				'data-state': open ? ('open' as const) : ('closed' as const),
				onclick: () => (open ? setOpen(false) : open_from_trigger('first')),
				onkeydown: handleTriggerKeydown
			};
		},
		menu_attrs() {
			return {
				id: menuId,
				role: 'menu' as const,
				'aria-label': options.label,
				'data-state': open ? ('open' as const) : ('closed' as const),
				'data-side': floating.side,
				style: floating.style,
				onkeydown: handleMenuKeydown
			};
		},
		item_attrs(id: string) {
			const item = byId.get(id);
			const disabled = item?.disabled === true;
			const role = item?.role ?? 'menuitem';
			const rov = roving.item_attrs(id);
			const highlighted = !disabled && roving.active === id;
			return {
				role,
				'aria-disabled': disabled ? (true as const) : undefined,
				'aria-checked': role === 'menuitem' ? undefined : item?.checked === true,
				'data-highlighted': highlighted ? '' : undefined,
				'data-disabled': disabled ? '' : undefined,
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onpointermove: () => {
					if (!disabled && roving.active !== id) roving.focus(id);
				},
				onclick: (event: MouseEvent) => {
					event.stopPropagation();
					activate(id);
				}
			};
		}
	};
}
