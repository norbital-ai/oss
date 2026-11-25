// Higher-level headless widget behaviors achieving full parity with `@ui-sdk/core`:
// - `create_panel_group`: N-pane percentage split layout with collapsible panels, double-click reset & persistence
// - `create_carousel`: scroll-snap slides, loop, autoplay (paused on hover/focus/reduced-motion) & indicators
// - `create_menubar` & `create_navigation_menu`: horizontal cross-menu handoff & mega-menu hover viewport
// - `create_hover_card`: rich non-modal hover preview card
// - Color math (`parse_color`, `format_color`, `rgb_to_hsl`, `hsl_to_rgb`, `rgb_to_hsv`, `hsv_to_rgb`, `contrast_ratio`, `mix_colors`) & `create_color_picker`
// - `create_image_cropper`: aspect-locked crop rect move/resize, zoom, rotation & pixel conversion
// - `create_waterfall` & `create_timeline`: trace/Gantt waterfall & activity timeline behaviors
import type { Attachment } from 'svelte/attachments';
import { announce } from './announce.svelte.js';
import { create_area, create_move } from './canvas.svelte.js';
import { register_control } from './controls.svelte.js';
import { create_dismiss } from './dismiss.svelte.js';
import { bind_drag } from './drag.svelte.js';
import { create_floating, type FloatingAlign, type FloatingSide } from './floating.svelte.js';
import { create_hover_intent } from './hover-intent.svelte.js';
import { create_presence } from './presence.svelte.js';
import { create_resize_box } from './resize.svelte.js';
import { create_roving_focus } from './roving-focus.svelte.js';
import { create_slider } from './slider.svelte.js';
import { create_tree, type TreeNode } from './tree.svelte.js';

/** Configuration for one pane inside `create_panel_group`. */
export type PanelSpec = {
	readonly id: string;
	readonly default_size: number;
	readonly min_size?: number;
	readonly max_size?: number;
	readonly collapsible?: boolean;
};

/** Options for `create_panel_group`. */
export type PanelGroupOptions = {
	readonly panels: readonly PanelSpec[];
	readonly direction?: 'horizontal' | 'vertical';
	readonly storage_key?: string;
	readonly on_layout?: (sizes: readonly number[]) => void;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_panel_group`. */
export type PanelGroup = ReturnType<typeof create_panel_group>;

/**
 * Multi-pane percentage resizable layout group (`role="separator"` handles between adjacent panes)
 * with min/max clamping, collapsible snap-to-zero, double-click reset, keyboard stepping and optional persistence.
 */
export function create_panel_group(options: PanelGroupOptions) {
	const horizontal = (options.direction ?? 'horizontal') === 'horizontal';
	const defaults = options.panels.map((p) => p.default_size);

	function loadInitial(): readonly number[] {
		if (options.storage_key !== undefined && typeof window !== 'undefined') {
			try {
				const raw = window.localStorage.getItem(options.storage_key);
				if (raw !== null) {
					const parsed: unknown = JSON.parse(raw);
					if (
						Array.isArray(parsed) &&
						parsed.length === options.panels.length &&
						parsed.every((n): n is number => typeof n === 'number' && Number.isFinite(n))
					) {
						return parsed;
					}
				}
			} catch {
				// Ignore corrupt storage.
			}
		}
		return defaults;
	}

	let sizes = $state<readonly number[]>(loadInitial());
	let activeHandle = $state<number | null>(null);
	let containerEl = $state<HTMLElement | null>(null);

	function commit(next: readonly number[]): void {
		sizes = next;
		options.on_layout?.(next);
		if (options.storage_key !== undefined && typeof window !== 'undefined') {
			try {
				window.localStorage.setItem(options.storage_key, JSON.stringify(next));
			} catch {
				// Ignore quota errors.
			}
		}
	}

	function resizePair(handleIndex: number, deltaPct: number): void {
		const leftSpec = options.panels[handleIndex];
		const rightSpec = options.panels[handleIndex + 1];
		const curLeft = sizes[handleIndex];
		const curRight = sizes[handleIndex + 1];
		if (leftSpec === undefined || rightSpec === undefined || curLeft === undefined || curRight === undefined) return;
		const total = curLeft + curRight;
		const leftMin = leftSpec.collapsible ? 0 : (leftSpec.min_size ?? 5);
		const leftMax = leftSpec.max_size ?? 100;
		const rightMin = rightSpec.collapsible ? 0 : (rightSpec.min_size ?? 5);
		const rightMax = rightSpec.max_size ?? 100;

		let nextLeft = Math.max(leftMin, Math.min(leftMax, curLeft + deltaPct));
		let nextRight = total - nextLeft;
		if (nextRight < rightMin) {
			nextRight = rightMin;
			nextLeft = total - nextRight;
		} else if (nextRight > rightMax) {
			nextRight = rightMax;
			nextLeft = total - nextRight;
		}
		if (leftSpec.collapsible && nextLeft < (leftSpec.min_size ?? 10) / 2) {
			nextLeft = 0;
			nextRight = total;
		}
		if (rightSpec.collapsible && nextRight < (rightSpec.min_size ?? 10) / 2) {
			nextRight = 0;
			nextLeft = total;
		}
		const updated = sizes.map((v, i) =>
			i === handleIndex ? Number(nextLeft.toFixed(2)) : i === handleIndex + 1 ? Number(nextRight.toFixed(2)) : v
		);
		commit(updated);
	}

	function reset(): void {
		commit(defaults);
	}

	function handle(handleIndex: number): Attachment<HTMLElement> {
		let startSizes: readonly number[] = [];
		let containerSpan = 1000;
		return bind_drag({
			threshold: 0,
			on_start: () => {
				startSizes = sizes;
				const rect = containerEl?.getBoundingClientRect();
				containerSpan = Math.max(100, horizontal ? (rect?.width ?? 1000) : (rect?.height ?? 600));
				activeHandle = handleIndex;
				return true;
			},
			on_move: (sample) => {
				const deltaPx = horizontal ? sample.dx : sample.dy;
				const deltaPct = (deltaPx / containerSpan) * 100;
				sizes = startSizes;
				resizePair(handleIndex, deltaPct);
			},
			on_end: (_event, canceled) => {
				activeHandle = null;
				if (canceled) commit(startSizes);
			}
		});
	}

	const container: Attachment<HTMLElement> = (el) => {
		containerEl = el;
		return () => {
			if (containerEl === el) containerEl = null;
		};
	};

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'panel-group',
				...(meta.label !== undefined ? { label: meta.label } : {}),
				element: () => containerEl,
				state: () => ({ sizes }),
				actions: {
					reset,
					set_sizes: (next) => {
						if (Array.isArray(next) && next.length === options.panels.length && next.every((n): n is number => typeof n === 'number')) {
							commit(next);
						}
					}
				}
			})
		);
	}

	return {
		get sizes() {
			return sizes;
		},
		get dragging() {
			return activeHandle;
		},
		size_of(index: number): number {
			return sizes[index] ?? 0;
		},
		reset,
		container,
		handle,
		handle_attrs(handleIndex: number) {
			const val = sizes[handleIndex] ?? 0;
			const spec = options.panels[handleIndex];
			return {
				role: 'separator' as const,
				tabindex: 0,
				'aria-orientation': horizontal ? ('vertical' as const) : ('horizontal' as const),
				'aria-valuenow': Math.round(val),
				'aria-valuemin': spec?.min_size ?? 0,
				'aria-valuemax': spec?.max_size ?? 100,
				'data-dragging': activeHandle === handleIndex ? '' : undefined,
				ondblclick: () => reset(),
				onkeydown: (event: KeyboardEvent) => {
					const step = event.shiftKey ? 10 : 2;
					if ((horizontal && event.key === 'ArrowRight') || (!horizontal && event.key === 'ArrowDown')) {
						event.preventDefault();
						resizePair(handleIndex, step);
					} else if ((horizontal && event.key === 'ArrowLeft') || (!horizontal && event.key === 'ArrowUp')) {
						event.preventDefault();
						resizePair(handleIndex, -step);
					} else if (event.key === 'Home') {
						event.preventDefault();
						resizePair(handleIndex, -100);
					} else if (event.key === 'End') {
						event.preventDefault();
						resizePair(handleIndex, 100);
					}
				}
			};
		}
	};
}

/** Options for `create_carousel`. */
export type CarouselOptions = {
	readonly count: () => number;
	readonly index?: () => number;
	readonly default_index?: number;
	readonly on_change?: (index: number) => void;
	readonly loop?: boolean;
	readonly autoplay_ms?: number;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_carousel`. */
export type CarouselBehavior = ReturnType<typeof create_carousel>;

/**
 * Accessible slide carousel (`aria-roledescription="carousel"`) with Arrow/Home/End navigation,
 * optional looping, indicator dots, autoplay that pauses on hover/focus/reduced-motion, and control registration.
 */
export function create_carousel(options: CarouselOptions) {
	const loop = options.loop === true;
	let internal = $state(options.default_index ?? 0);
	let paused = $state(false);
	let rootEl = $state<HTMLElement | null>(null);
	let trackEl = $state<HTMLElement | null>(null);

	const total = $derived(Math.max(0, options.count()));
	const index = $derived(
		total === 0 ? 0 : Math.max(0, Math.min(total - 1, options.index ? options.index() : internal))
	);
	const can_prev = $derived(total > 1 && (loop || index > 0));
	const can_next = $derived(total > 1 && (loop || index < total - 1));

	function go_to(next: number): void {
		if (total === 0) return;
		const resolved = loop ? ((next % total) + total) % total : Math.max(0, Math.min(total - 1, next));
		if (resolved === index) return;
		if (!options.index) internal = resolved;
		options.on_change?.(resolved);
		const child = trackEl?.children[resolved];
		if (child instanceof HTMLElement && typeof child.scrollIntoView === 'function') {
			child.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
		}
		announce(`Slide ${resolved + 1} of ${total}`);
	}

	function next(): void {
		if (can_next) go_to(index + 1);
	}

	function prev(): void {
		if (can_prev) go_to(index - 1);
	}

	$effect(() => {
		const ms = options.autoplay_ms;
		if (ms === undefined || ms <= 0 || paused || total <= 1) return;
		if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
			return;
		}
		const id = setInterval(() => {
			if (loop || index < total - 1) go_to(index + 1);
		}, ms);
		return () => clearInterval(id);
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'carousel',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				element: () => rootEl,
				state: () => ({ index, count: total, paused }),
				actions: {
					next,
					previous: prev,
					go: (n) => {
						if (typeof n === 'number') go_to(n);
					}
				}
			})
		);
	}

	const root: Attachment<HTMLElement> = (el) => {
		rootEl = el;
		return () => {
			if (rootEl === el) rootEl = null;
		};
	};

	const track: Attachment<HTMLElement> = (el) => {
		trackEl = el;
		return () => {
			if (trackEl === el) trackEl = null;
		};
	};

	return {
		get index() {
			return index;
		},
		get count() {
			return total;
		},
		get can_prev() {
			return can_prev;
		},
		get can_next() {
			return can_next;
		},
		get paused() {
			return paused;
		},
		go_to,
		next,
		prev,
		set_paused(p: boolean) {
			paused = p;
		},
		root,
		track,
		root_attrs() {
			return {
				role: 'region' as const,
				'aria-roledescription': 'carousel',
				'aria-label': options.label ?? 'Carousel',
				onpointerenter: () => (paused = true),
				onpointerleave: () => (paused = false),
				onfocusin: () => (paused = true),
				onfocusout: () => (paused = false),
				onkeydown: (event: KeyboardEvent) => {
					if (event.key === 'ArrowRight') {
						event.preventDefault();
						next();
					} else if (event.key === 'ArrowLeft') {
						event.preventDefault();
						prev();
					} else if (event.key === 'Home') {
						event.preventDefault();
						go_to(0);
					} else if (event.key === 'End') {
						event.preventDefault();
						go_to(total - 1);
					}
				}
			};
		},
		slide_attrs(i: number) {
			return {
				role: 'group' as const,
				'aria-roledescription': 'slide',
				'aria-label': `${i + 1} of ${total}`,
				'aria-hidden': i !== index ? (true as const) : undefined,
				'data-active': i === index ? '' : undefined
			};
		},
		dot_attrs(i: number) {
			return {
				type: 'button' as const,
				'aria-label': `Go to slide ${i + 1}`,
				'aria-current': i === index ? ('true' as const) : undefined,
				'data-active': i === index ? '' : undefined,
				onclick: () => go_to(i)
			};
		}
	};
}

/** Options for `create_menubar`. */
export type MenubarOptions = {
	readonly menus: () => readonly string[];
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_menubar`. */
export type MenubarBehavior = ReturnType<typeof create_menubar>;

/**
 * Desktop application `role="menubar"` coordinator: horizontal roving focus across top-level
 * menu triggers, hover-switch when any menu is open, cross-menu ArrowLeft/ArrowRight handoff and Escape close.
 */
export function create_menubar(options: MenubarOptions) {
	let openMenu = $state<string | null>(null);
	let rootEl = $state<HTMLElement | null>(null);

	const roving = create_roving_focus({
		items: options.menus,
		orientation: 'horizontal',
		loop: true,
		on_active_change: (key) => {
			if (openMenu !== null) openMenu = key;
		}
	});

	create_dismiss({
		open: () => openMenu !== null,
		escape: true,
		outside: true,
		ignore: () => (rootEl !== null ? [rootEl] : []),
		on_dismiss: () => {
			const prev = openMenu;
			openMenu = null;
			if (prev !== null) roving.focus(prev);
		}
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'menubar',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				element: () => rootEl,
				state: () => ({ open_menu: openMenu, menus: options.menus() }),
				actions: {
					open: (id) => {
						if (typeof id === 'string') openMenu = id;
					},
					close: () => {
						openMenu = null;
					}
				}
			})
		);
	}

	const root: Attachment<HTMLElement> = (el) => {
		rootEl = el;
		return () => {
			if (rootEl === el) rootEl = null;
		};
	};

	return {
		get open_menu() {
			return openMenu;
		},
		is_open(id: string): boolean {
			return openMenu === id;
		},
		open(id: string): void {
			openMenu = id;
			roving.focus(id);
		},
		close(): void {
			openMenu = null;
		},
		root,
		item: roving.item,
		root_attrs() {
			return {
				role: 'menubar' as const,
				'aria-label': options.label ?? 'Menu bar',
				onkeydown: roving.root_attrs().onkeydown
			};
		},
		trigger_attrs(id: string) {
			const rov = roving.item_attrs(id);
			const active = openMenu === id;
			return {
				type: 'button' as const,
				role: 'menuitem' as const,
				'aria-haspopup': 'menu' as const,
				'aria-expanded': active,
				'data-state': active ? ('open' as const) : ('closed' as const),
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onclick: () => {
					openMenu = active ? null : id;
				},
				onpointerenter: () => {
					if (openMenu !== null && openMenu !== id) {
						openMenu = id;
						roving.focus(id);
					}
				},
				onkeydown: (event: KeyboardEvent) => {
					if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
						event.preventDefault();
						openMenu = id;
					}
				}
			};
		}
	};
}

/** Options for `create_navigation_menu`. */
export type NavigationMenuOptions = {
	readonly items: () => readonly string[];
	readonly open_delay?: number;
	readonly close_delay?: number;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_navigation_menu`. */
export type NavigationMenuBehavior = ReturnType<typeof create_navigation_menu>;

/**
 * Site/app mega-menu navigation behavior: hover-intent opening with shared warm group,
 * click toggle, keyboard roving focus across top-level triggers and Escape/outside dismissal.
 */
export function create_navigation_menu(options: NavigationMenuOptions) {
	let active = $state<string | null>(null);
	let rootEl = $state<HTMLElement | null>(null);
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	const openDelay = options.open_delay ?? 150;
	const closeDelay = options.close_delay ?? 200;

	function clearTimers(): void {
		if (openTimer !== undefined) clearTimeout(openTimer);
		if (closeTimer !== undefined) clearTimeout(closeTimer);
		openTimer = undefined;
		closeTimer = undefined;
	}

	function scheduleOpen(id: string): void {
		clearTimers();
		if (active !== null || openDelay <= 0) {
			active = id;
			return;
		}
		openTimer = setTimeout(() => {
			openTimer = undefined;
			active = id;
		}, openDelay);
	}

	function scheduleClose(): void {
		clearTimers();
		if (closeDelay <= 0) {
			active = null;
			return;
		}
		closeTimer = setTimeout(() => {
			closeTimer = undefined;
			active = null;
		}, closeDelay);
	}

	$effect(() => () => clearTimers());

	const roving = create_roving_focus({
		items: options.items,
		orientation: 'horizontal',
		loop: true
	});

	create_dismiss({
		open: () => active !== null,
		escape: true,
		outside: true,
		ignore: () => (rootEl !== null ? [rootEl] : []),
		on_dismiss: () => {
			clearTimers();
			active = null;
		}
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'navigation-menu',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				element: () => rootEl,
				state: () => ({ open_item: active, items: options.items() }),
				actions: {
					open: (id) => {
						if (typeof id === 'string') {
							clearTimers();
							active = id;
						}
					},
					close: () => {
						clearTimers();
						active = null;
					}
				}
			})
		);
	}

	const root: Attachment<HTMLElement> = (el) => {
		rootEl = el;
		return () => {
			if (rootEl === el) rootEl = null;
		};
	};

	return {
		get active() {
			return active;
		},
		is_open(id: string): boolean {
			return active === id;
		},
		open(id: string): void {
			clearTimers();
			active = id;
		},
		close(): void {
			clearTimers();
			active = null;
		},
		root,
		item: roving.item,
		root_attrs() {
			return {
				'aria-label': options.label ?? 'Main navigation',
				onpointerleave: () => scheduleClose(),
				onkeydown: roving.root_attrs().onkeydown
			};
		},
		trigger_attrs(id: string) {
			const rov = roving.item_attrs(id);
			const isOpen = active === id;
			return {
				type: 'button' as const,
				'aria-expanded': isOpen,
				'data-state': isOpen ? ('open' as const) : ('closed' as const),
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onpointerenter: () => scheduleOpen(id),
				onclick: () => {
					clearTimers();
					active = isOpen ? null : id;
				}
			};
		},
		content_attrs() {
			return {
				onpointerenter: () => clearTimers(),
				onpointerleave: () => scheduleClose()
			};
		}
	};
}

/** Options for `create_hover_card`. */
export type HoverCardOptions = {
	readonly open?: () => boolean;
	readonly on_open_change?: (open: boolean) => void;
	readonly open_delay?: number;
	readonly close_delay?: number;
	readonly side?: FloatingSide;
	readonly align?: FloatingAlign;
	readonly group?: string;
};

/** Return value of `create_hover_card`. */
export type HoverCardBehavior = ReturnType<typeof create_hover_card>;

/**
 * Rich non-modal hover preview card composing `create_hover_intent`, `create_floating`,
 * `create_presence` and Escape dismissal (pointer safe-corridor keeps the card open while moving into it).
 */
export function create_hover_card(options: HoverCardOptions = {}) {
	let internalOpen = $state(false);
	let triggerEl = $state<HTMLElement | null>(null);
	let popupEl = $state<HTMLElement | null>(null);
	const open = $derived(options.open ? options.open() : internalOpen);

	function setOpen(next: boolean): void {
		if (next === open) return;
		if (!options.open) internalOpen = next;
		options.on_open_change?.(next);
	}

	const intent = create_hover_intent({
		open: () => open,
		trigger: () => triggerEl,
		popup: () => popupEl,
		on_open: () => setOpen(true),
		on_close: () => setOpen(false),
		open_delay: options.open_delay ?? 300,
		close_delay: options.close_delay ?? 200,
		hoverable: true,
		...(options.group !== undefined ? { group: options.group } : {})
	});

	const floating = create_floating({
		open: () => open,
		side: options.side ?? 'bottom',
		align: options.align ?? 'center',
		escape: true,
		outside: false,
		on_dismiss: () => setOpen(false)
	});

	const presence = create_presence({ open: () => open });

	const trigger: Attachment<HTMLElement> = (el) => {
		triggerEl = el;
		const stopAnchor = floating.anchor(el);
		return () => {
			stopAnchor?.();
			if (triggerEl === el) triggerEl = null;
		};
	};

	const content: Attachment<HTMLElement> = (el) => {
		popupEl = el;
		const stopFloat = floating.content(el);
		const stopPres = presence.attach(el);
		return () => {
			stopPres?.();
			stopFloat?.();
			if (popupEl === el) popupEl = null;
		};
	};

	return {
		get open() {
			return open;
		},
		get present() {
			return presence.present;
		},
		get floating() {
			return floating;
		},
		set_open: setOpen,
		trigger,
		content,
		trigger_attrs() {
			return {
				'aria-expanded': open,
				onpointerenter: (e: PointerEvent) => intent.enter(e, true),
				onpointerleave: (e: PointerEvent) => intent.leave(e),
				onfocus: () => intent.enter(undefined, true),
				onblur: () => intent.leave(undefined)
			};
		},
		content_attrs() {
			return {
				'data-state': open ? ('open' as const) : ('closed' as const),
				style: floating.style,
				onpointerenter: (e: PointerEvent) => intent.enter(e, false),
				onpointerleave: (e: PointerEvent) => intent.leave(e)
			};
		}
	};
}

/** RGBA color representation with channels `r,g,b` in `0..255` and alpha `a` in `0..1`. */
export type RgbaColor = {
	readonly r: number;
	readonly g: number;
	readonly b: number;
	readonly a: number;
};

/** HSLA color representation (`h` in `0..360`, `s,l` in `0..100`, `a` in `0..1`). */
export type HslaColor = {
	readonly h: number;
	readonly s: number;
	readonly l: number;
	readonly a: number;
};

/** HSVA color representation (`h` in `0..360`, `s,v` in `0..100`, `a` in `0..1`). */
export type HsvaColor = {
	readonly h: number;
	readonly s: number;
	readonly v: number;
	readonly a: number;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Converts RGB (`0..255`) + alpha (`0..1`) to HSL (`h: 0..360, s: 0..100, l: 0..100`). */
export function rgb_to_hsl(color: RgbaColor): HslaColor {
	const r = color.r / 255;
	const g = color.g / 255;
	const b = color.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	const l = (max + min) / 2;
	let h = 0;
	const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
	if (d !== 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h = (h * 60 + 360) % 360;
	}
	return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100), a: clamp01(color.a) };
}

/** Converts HSL (`h: 0..360, s: 0..100, l: 0..100`) to RGBA (`0..255`). */
export function hsl_to_rgb(color: HslaColor): RgbaColor {
	const h = ((color.h % 360) + 360) % 360;
	const s = clamp01(color.s / 100);
	const l = clamp01(color.l / 100);
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255), a: clamp01(color.a) };
}

/** Converts RGB (`0..255`) to HSV (`h: 0..360, s: 0..100, v: 0..100`). */
export function rgb_to_hsv(color: RgbaColor): HsvaColor {
	const r = color.r / 255;
	const g = color.g / 255;
	const b = color.b / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;
	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d) % 6;
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h = (h * 60 + 360) % 360;
	}
	const s = max === 0 ? 0 : d / max;
	return { h: Math.round(h), s: Math.round(s * 100), v: Math.round(max * 100), a: clamp01(color.a) };
}

/** Converts HSV (`h: 0..360, s: 0..100, v: 0..100`) to RGBA (`0..255`). */
export function hsv_to_rgb(color: HsvaColor): RgbaColor {
	const h = ((color.h % 360) + 360) % 360;
	const s = clamp01(color.s / 100);
	const v = clamp01(color.v / 100);
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return { r: clampByte((r + m) * 255), g: clampByte((g + m) * 255), b: clampByte((b + m) * 255), a: clamp01(color.a) };
}

/** Parses CSS `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)` or `hsl(...)` strings into `RgbaColor`. */
export function parse_color(input: string): RgbaColor | null {
	const raw = input.trim().toLowerCase();
	if (raw.startsWith('#')) {
		const hex = raw.slice(1);
		if (!/^[0-9a-f]+$/.test(hex)) return null;
		if (hex.length === 3 || hex.length === 4) {
			const r = Number.parseInt(hex.charAt(0).repeat(2), 16);
			const g = Number.parseInt(hex.charAt(1).repeat(2), 16);
			const b = Number.parseInt(hex.charAt(2).repeat(2), 16);
			const a = hex.length === 4 ? Number.parseInt(hex.charAt(3).repeat(2), 16) / 255 : 1;
			return { r, g, b, a };
		}
		if (hex.length === 6 || hex.length === 8) {
			const r = Number.parseInt(hex.slice(0, 2), 16);
			const g = Number.parseInt(hex.slice(2, 4), 16);
			const b = Number.parseInt(hex.slice(4, 6), 16);
			const a = hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1;
			return { r, g, b, a };
		}
		return null;
	}
	const rgbMatch = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(raw);
	if (rgbMatch !== null) {
		const aRaw = rgbMatch[4];
		const a = aRaw === undefined ? 1 : aRaw.endsWith('%') ? Number.parseFloat(aRaw) / 100 : Number.parseFloat(aRaw);
		return {
			r: clampByte(Number(rgbMatch[1])),
			g: clampByte(Number(rgbMatch[2])),
			b: clampByte(Number(rgbMatch[3])),
			a: clamp01(a)
		};
	}
	const hslMatch = /^hsla?\(\s*([\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(raw);
	if (hslMatch !== null) {
		const aRaw = hslMatch[4];
		const a = aRaw === undefined ? 1 : aRaw.endsWith('%') ? Number.parseFloat(aRaw) / 100 : Number.parseFloat(aRaw);
		return hsl_to_rgb({ h: Number(hslMatch[1]), s: Number(hslMatch[2]), l: Number(hslMatch[3]), a });
	}
	return null;
}

/** Formats an `RgbaColor` as `'hex'`, `'rgb'` or `'hsl'`. */
export function format_color(color: RgbaColor, format: 'hex' | 'rgb' | 'hsl' = 'hex'): string {
	const r = clampByte(color.r);
	const g = clampByte(color.g);
	const b = clampByte(color.b);
	const a = clamp01(color.a);
	if (format === 'hex') {
		const base = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
		if (a >= 0.999) return base;
		return `${base}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
	}
	if (format === 'rgb') {
		return a >= 0.999 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
	}
	const hsl = rgb_to_hsl(color);
	return a >= 0.999
		? `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`
		: `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${Number(a.toFixed(2))})`;
}

function relativeLuminance(c: RgbaColor): number {
	const chan = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

/** Computes WCAG 2.1 contrast ratio (`1..21`) between two colors. */
export function contrast_ratio(a: RgbaColor, b: RgbaColor): number {
	const l1 = relativeLuminance(a);
	const l2 = relativeLuminance(b);
	const hi = Math.max(l1, l2);
	const lo = Math.min(l1, l2);
	return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}

/** Linearly mixes two RGBA colors (`t = 0` -> `a`, `t = 1` -> `b`). */
export function mix_colors(a: RgbaColor, b: RgbaColor, t: number): RgbaColor {
	const k = clamp01(t);
	return {
		r: clampByte(a.r + (b.r - a.r) * k),
		g: clampByte(a.g + (b.g - a.g) * k),
		b: clampByte(a.b + (b.b - a.b) * k),
		a: clamp01(a.a + (b.a - a.a) * k)
	};
}

/** Options for `create_color_picker`. */
export type ColorPickerOptions = {
	readonly value?: () => string;
	readonly default_value?: string;
	readonly on_change?: (hex: string, rgba: RgbaColor) => void;
	readonly format?: 'hex' | 'rgb' | 'hsl';
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_color_picker`. */
export type ColorPickerBehavior = ReturnType<typeof create_color_picker>;

/**
 * Headless color picker composing 2D saturation/brightness `create_area`, hue & alpha `create_slider`,
 * color parsing/formatting and Norbius control registration.
 */
export function create_color_picker(options: ColorPickerOptions = {}) {
	const fmt = options.format ?? 'hex';
	const fallback: RgbaColor = { r: 37, g: 99, b: 235, a: 1 };
	let internal = $state(options.default_value ?? '#2563eb');
	const rawText = $derived(options.value ? options.value() : internal);
	const rgba = $derived(parse_color(rawText) ?? fallback);
	const hsv = $derived(rgb_to_hsv(rgba));

	function commitRgba(next: RgbaColor): void {
		const formatted = format_color(next, fmt);
		if (!options.value) internal = formatted;
		options.on_change?.(formatted, next);
	}

	function set_text(text: string): boolean {
		const parsed = parse_color(text);
		if (parsed === null) return false;
		commitRgba(parsed);
		return true;
	}

	const plane = create_area({
		value: () => ({ x: hsv.s, y: 100 - hsv.v }),
		min_x: 0,
		max_x: 100,
		min_y: 0,
		max_y: 100,
		step_x: 1,
		step_y: 1,
		label: 'Saturation and brightness',
		on_change: (pt) => commitRgba(hsv_to_rgb({ h: hsv.h, s: pt.x, v: 100 - pt.y, a: hsv.a }))
	});

	const hue = create_slider({
		min: 0,
		max: 360,
		step: 1,
		value: () => hsv.h,
		label: 'Hue',
		on_change: (h) => commitRgba(hsv_to_rgb({ h, s: hsv.s, v: hsv.v, a: hsv.a }))
	});

	const alpha = create_slider({
		min: 0,
		max: 100,
		step: 1,
		value: () => Math.round(hsv.a * 100),
		label: 'Alpha',
		on_change: (pct) => commitRgba({ ...rgba, a: pct / 100 })
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'color-picker',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ value: format_color(rgba, fmt), hex: format_color(rgba, 'hex') }),
				actions: {
					set: (v) => {
						if (typeof v === 'string') set_text(v);
					}
				}
			})
		);
	}

	return {
		get value() {
			return format_color(rgba, fmt);
		},
		get rgba() {
			return rgba;
		},
		get hsv() {
			return hsv;
		},
		get plane() {
			return plane;
		},
		get hue() {
			return hue;
		},
		get alpha() {
			return alpha;
		},
		set_text,
		set_rgba: commitRgba
	};
}

/** Normalized (`0..1`) crop rectangle over an image. */
export type CropRect = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};

/** Options for `create_image_cropper`. */
export type ImageCropperOptions = {
	readonly default_crop?: CropRect;
	readonly aspect?: () => number | undefined;
	readonly min_size?: number;
	readonly on_change?: (crop: CropRect, meta: { readonly zoom: number; readonly rotation: number }) => void;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_image_cropper`. */
export type ImageCropperBehavior = ReturnType<typeof create_image_cropper>;

/**
 * Headless image cropper with aspect-locked move & resize, zoom, rotation, pixel-crop export
 * and Norbius control registration.
 */
export function create_image_cropper(options: ImageCropperOptions = {}) {
	const minSize = options.min_size ?? 0.1;
	let crop = $state<CropRect>(options.default_crop ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
	let zoom = $state(1);
	let rotation = $state(0);

	function clampCrop(next: CropRect): CropRect {
		const aspect = options.aspect?.();
		let width = Math.max(minSize, Math.min(1, next.width));
		let height = aspect !== undefined && aspect > 0 ? width / aspect : Math.max(minSize, Math.min(1, next.height));
		if (height > 1) {
			height = 1;
			if (aspect !== undefined && aspect > 0) width = Math.min(1, height * aspect);
		}
		const x = Math.max(0, Math.min(1 - width, next.x));
		const y = Math.max(0, Math.min(1 - height, next.y));
		return {
			x: Number(x.toFixed(4)),
			y: Number(y.toFixed(4)),
			width: Number(width.toFixed(4)),
			height: Number(height.toFixed(4))
		};
	}

	function setCrop(next: CropRect): void {
		crop = clampCrop(next);
		options.on_change?.(crop, { zoom, rotation });
	}

	function setZoom(next: number): void {
		zoom = Math.max(1, Math.min(5, Number(next.toFixed(2))));
		options.on_change?.(crop, { zoom, rotation });
	}

	function rotate(deg = 90): void {
		rotation = ((rotation + deg) % 360 + 360) % 360;
		options.on_change?.(crop, { zoom, rotation });
	}

	const mover = create_move({
		position: () => ({ x: crop.x * 100, y: crop.y * 100 }),
		step: 2,
		bounds: () => ({ min_x: 0, max_x: (1 - crop.width) * 100, min_y: 0, max_y: (1 - crop.height) * 100 }),
		label: options.label ?? 'Crop region',
		on_change: (pt) => setCrop({ ...crop, x: pt.x / 100, y: pt.y / 100 })
	});

	const resizer = create_resize_box({
		size: () => ({ width: crop.width * 100, height: crop.height * 100 }),
		min_width: minSize * 100,
		max_width: 100,
		min_height: minSize * 100,
		max_height: 100,
		step: 2,
		on_change: (sz) => setCrop({ ...crop, width: sz.width / 100, height: sz.height / 100 })
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'image-cropper',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ crop, zoom, rotation }),
				actions: {
					zoom: (z) => {
						if (typeof z === 'number') setZoom(z);
					},
					rotate: (deg) => rotate(typeof deg === 'number' ? deg : 90),
					reset: () => {
						zoom = 1;
						rotation = 0;
						setCrop(options.default_crop ?? { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
					}
				}
			})
		);
	}

	return {
		get crop() {
			return crop;
		},
		get zoom() {
			return zoom;
		},
		get rotation() {
			return rotation;
		},
		get mover() {
			return mover;
		},
		get resizer() {
			return resizer;
		},
		set_crop: setCrop,
		set_zoom: setZoom,
		rotate,
		pixel_crop(naturalWidth: number, naturalHeight: number) {
			return {
				x: Math.round(crop.x * naturalWidth),
				y: Math.round(crop.y * naturalHeight),
				width: Math.round(crop.width * naturalWidth),
				height: Math.round(crop.height * naturalHeight)
			};
		}
	};
}

/** One timed span item in `create_waterfall`. */
export type WaterfallItem = {
	readonly id: string;
	readonly label: string;
	readonly parent?: string | null;
	readonly start: number;
	readonly end: number;
};

/** Options for `create_waterfall`. */
export type WaterfallOptions<T extends WaterfallItem = WaterfallItem> = {
	readonly items: () => readonly T[];
	readonly on_select?: (id: string) => void;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_waterfall`. */
export type WaterfallBehavior<T extends WaterfallItem = WaterfallItem> = ReturnType<typeof create_waterfall<T>>;

/**
 * Hierarchical trace/Gantt waterfall behavior composing `create_tree` with automatic time-domain
 * bounds, zoomable `[view_start, view_end]` window and percentage bar placement (`bar_rect`).
 */
export function create_waterfall<T extends WaterfallItem = WaterfallItem>(options: WaterfallOptions<T>) {
	let zoomWindow = $state<{ readonly start: number; readonly end: number } | null>(null);

	const built = $derived.by(() => {
		const list = options.items();
		const byId = new Map(list.map((item) => [item.id, item]));
		const kids = new Map<string, T[]>();
		const roots: T[] = [];
		let minStart = Number.POSITIVE_INFINITY;
		let maxEnd = Number.NEGATIVE_INFINITY;

		for (const item of list) {
			if (item.start < minStart) minStart = item.start;
			if (item.end > maxEnd) maxEnd = item.end;
			const pid = item.parent ?? null;
			if (pid !== null && pid !== item.id && byId.has(pid)) {
				const arr = kids.get(pid);
				if (arr !== undefined) arr.push(item);
				else kids.set(pid, [item]);
			} else {
				roots.push(item);
			}
		}

		const toNode = (item: T): TreeNode<T> => {
			const children = (kids.get(item.id) ?? []).map(toNode);
			return {
				id: item.id,
				label: item.label,
				data: item,
				...(children.length > 0 ? { children } : {})
			};
		};

		return {
			nodes: roots.map(toNode),
			min: Number.isFinite(minStart) ? minStart : 0,
			max: Number.isFinite(maxEnd) && maxEnd > minStart ? maxEnd : Number.isFinite(minStart) ? minStart + 1 : 1
		};
	});

	const tree = create_tree<T>({
		nodes: () => built.nodes,
		on_select: (ids) => {
			const first = ids[0];
			if (first !== undefined) options.on_select?.(first);
		},
		...(options.control !== undefined ? { control: options.control } : {})
	});

	const viewStart = $derived(zoomWindow?.start ?? built.min);
	const viewEnd = $derived(zoomWindow?.end ?? built.max);

	function bar_rect(item: WaterfallItem): { readonly left_pct: number; readonly width_pct: number } {
		const span = Math.max(1e-6, viewEnd - viewStart);
		const left = ((item.start - viewStart) / span) * 100;
		const right = ((item.end - viewStart) / span) * 100;
		const clampedLeft = Math.max(0, Math.min(100, left));
		const clampedRight = Math.max(clampedLeft, Math.min(100, right));
		return { left_pct: clampedLeft, width_pct: Math.max(0.5, clampedRight - clampedLeft) };
	}

	return {
		get rows() {
			return tree.rows;
		},
		get min() {
			return built.min;
		},
		get max() {
			return built.max;
		},
		get view_start() {
			return viewStart;
		},
		get view_end() {
			return viewEnd;
		},
		get tree() {
			return tree;
		},
		bar_rect,
		zoom(start: number, end: number) {
			if (end > start) zoomWindow = { start, end };
		},
		reset_zoom() {
			zoomWindow = null;
		}
	};
}

/** Options for `create_timeline`. */
export type TimelineOptions = {
	readonly items: () => readonly string[];
	readonly default_expanded?: readonly string[];
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_timeline`. */
export type TimelineBehavior = ReturnType<typeof create_timeline>;

/**
 * Accessible activity timeline behavior (`role="feed"` / ordered expandable entries) with
 * vertical keyboard navigation, per-entry expand/collapse and Norbius control registration.
 */
export function create_timeline(options: TimelineOptions) {
	let expanded = $state<readonly string[]>(options.default_expanded ?? []);
	const expandedSet = $derived(new Set(expanded));

	const roving = create_roving_focus({
		items: options.items,
		orientation: 'vertical',
		loop: false
	});

	function toggle(id: string): void {
		expanded = expandedSet.has(id) ? expanded.filter((k) => k !== id) : [...expanded, id];
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'timeline',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ count: options.items().length, expanded }),
				actions: {
					toggle: (id) => {
						if (typeof id === 'string') toggle(id);
					},
					expand_all: () => {
						expanded = [...options.items()];
					},
					collapse_all: () => {
						expanded = [];
					}
				}
			})
		);
	}

	return {
		get expanded() {
			return expanded;
		},
		is_expanded(id: string): boolean {
			return expandedSet.has(id);
		},
		toggle,
		item: roving.item,
		root_attrs() {
			return {
				role: 'feed' as const,
				'aria-label': options.label ?? 'Timeline',
				onkeydown: roving.root_attrs().onkeydown
			};
		},
		item_attrs(id: string) {
			const rov = roving.item_attrs(id);
			const open = expandedSet.has(id);
			return {
				role: 'article' as const,
				'aria-expanded': open,
				'data-expanded': open ? '' : undefined,
				tabindex: rov.tabindex,
				onfocus: rov.onfocus
			};
		}
	};
}
