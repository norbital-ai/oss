// Platform & ergonomics behaviors: visual viewport / virtual keyboard avoidance, pointer & color
// scheme preferences, keyboard vs pointer focus modality, focus-preserving toolbar buttons, custom
// drag previews, transient pointer previews, race-safe draft settling, cookie storage & overlay stack.
import type { Attachment } from 'svelte/attachments';
import { create_dismiss } from './dismiss.svelte.js';

/** Live visual viewport & software keyboard metrics from `bind_viewport`. */
export type ViewportState = {
	readonly width: number;
	readonly height: number;
	readonly offset_top: number;
	readonly offset_left: number;
	readonly scale: number;
	/** Estimated height in px occluded by an on-screen mobile keyboard (`0` on desktop). */
	readonly keyboard_height: number;
};

function readViewport(): ViewportState {
	if (typeof window === 'undefined') {
		return { width: 0, height: 0, offset_top: 0, offset_left: 0, scale: 1, keyboard_height: 0 };
	}
	const vv = window.visualViewport;
	if (vv === null || vv === undefined) {
		return {
			width: window.innerWidth,
			height: window.innerHeight,
			offset_top: 0,
			offset_left: 0,
			scale: 1,
			keyboard_height: 0
		};
	}
	const keyboardHeight = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
	return {
		width: Math.round(vv.width),
		height: Math.round(vv.height),
		offset_top: Math.round(vv.offsetTop),
		offset_left: Math.round(vv.offsetLeft),
		scale: vv.scale,
		keyboard_height: keyboardHeight > 80 ? keyboardHeight : 0
	};
}

/**
 * Tracks `window.visualViewport` resize/scroll changes and writes `--viewport-height`,
 * `--keyboard-height` and `--keyboard-inset` CSS custom properties onto the bound element
 * (or `document.documentElement`).
 */
export function bind_viewport(on_change?: (state: ViewportState) => void): Attachment<HTMLElement> {
	return (el) => {
		const update = () => {
			const state = readViewport();
			const vv = typeof window !== 'undefined' ? window.visualViewport : null;
			const rawInset =
				vv !== null && vv !== undefined
					? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
					: 0;
			el.style.setProperty('--viewport-height', `${state.height}px`);
			el.style.setProperty('--keyboard-height', `${state.keyboard_height}px`);
			el.style.setProperty('--keyboard-inset', `${rawInset}px`);
			on_change?.(state);
		};
		update();
		const vv = typeof window !== 'undefined' ? window.visualViewport : null;
		vv?.addEventListener('resize', update);
		vv?.addEventListener('scroll', update);
		window.addEventListener('resize', update);
		return () => {
			vv?.removeEventListener('resize', update);
			vv?.removeEventListener('scroll', update);
			window.removeEventListener('resize', update);
		};
	};
}

/**
 * Shifts a fixed bottom bar, composer or sheet above the mobile software keyboard using
 * `visualViewport` keyboard-height measurements (`padding-bottom` or `transform`).
 */
export function bind_avoid_keyboard(options: { readonly mode?: 'padding' | 'translate' } = {}): Attachment<HTMLElement> {
	const mode = options.mode ?? 'translate';
	return (el) => {
		const prevTransform = el.style.transform;
		const prevPadding = el.style.paddingBottom;
		const stop = bind_viewport((state) => {
			if (mode === 'padding') {
				el.style.paddingBottom = state.keyboard_height > 0 ? `${state.keyboard_height}px` : prevPadding;
			} else {
				el.style.transform = state.keyboard_height > 0 ? `translateY(-${state.keyboard_height}px)` : prevTransform;
			}
		})(el);
		return () => {
			stop?.();
			el.style.transform = prevTransform;
			el.style.paddingBottom = prevPadding;
		};
	};
}

/** Primary pointer precision (`'coarse'` touch vs `'fine'` mouse/trackpad). */
export type PointerPrecision = 'coarse' | 'fine';

/** Current device pointer capabilities. */
export type PointerKindState = {
	readonly precision: PointerPrecision;
	readonly hover: boolean;
};

/** Reads current device pointer precision and hover support synchronously. */
export function pointer_kind_of(): PointerKindState {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
		return { precision: 'fine', hover: true };
	}
	const coarse = window.matchMedia('(pointer: coarse)').matches;
	const hover = window.matchMedia('(hover: hover)').matches;
	return { precision: coarse ? 'coarse' : 'fine', hover };
}

/** Reactive primary pointer precision (`coarse`/`fine`) and hover capability store. */
export function create_pointer_kind() {
	let state = $state<PointerKindState>(pointer_kind_of());

	$effect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		const mCoarse = window.matchMedia('(pointer: coarse)');
		const mHover = window.matchMedia('(hover: hover)');
		const update = () => {
			state = { precision: mCoarse.matches ? 'coarse' : 'fine', hover: mHover.matches };
		};
		update();
		mCoarse.addEventListener('change', update);
		mHover.addEventListener('change', update);
		return () => {
			mCoarse.removeEventListener('change', update);
			mHover.removeEventListener('change', update);
		};
	});

	return {
		get precision() {
			return state.precision;
		},
		get hover() {
			return state.hover;
		},
		get coarse() {
			return state.precision === 'coarse';
		}
	};
}

/** User color-scheme preference. */
export type ColorSchemePreference = 'light' | 'dark' | 'system';

/** Resolved concrete color scheme. */
export type ResolvedColorScheme = 'light' | 'dark';

/** Reads the operating system's current preferred color scheme. */
export function color_scheme_of(): ResolvedColorScheme {
	if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
	return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Options for `create_color_scheme`. */
export type ColorSchemeOptions = {
	readonly storage_key?: string;
	readonly default_value?: ColorSchemePreference;
	readonly apply_class?: boolean;
};

/** Reactive color-scheme preference (`'light' | 'dark' | 'system'`) synced with OS and optional storage. */
export function create_color_scheme(options: ColorSchemeOptions = {}) {
	const key = options.storage_key;
	const readStored = (): ColorSchemePreference => {
		if (key !== undefined && typeof window !== 'undefined') {
			try {
				const raw = window.localStorage.getItem(key);
				if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
			} catch {
				// Ignore storage access errors in private browsing.
			}
		}
		return options.default_value ?? 'system';
	};

	let preference = $state<ColorSchemePreference>(readStored());
	let system = $state<ResolvedColorScheme>(color_scheme_of());
	const resolved = $derived<ResolvedColorScheme>(preference === 'system' ? system : preference);

	$effect(() => {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => {
			system = mq.matches ? 'dark' : 'light';
		};
		onChange();
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});

	$effect(() => {
		if (options.apply_class === false || typeof document === 'undefined') return;
		document.documentElement.classList.toggle('dark', resolved === 'dark');
		document.documentElement.dataset['colorScheme'] = resolved;
	});

	function set(next: ColorSchemePreference): void {
		preference = next;
		if (key !== undefined && typeof window !== 'undefined') {
			try {
				window.localStorage.setItem(key, next);
			} catch {
				// Ignore quota/security failures.
			}
		}
	}

	return {
		get preference() {
			return preference;
		},
		get system() {
			return system;
		},
		get resolved() {
			return resolved;
		},
		set
	};
}

/** Generates a minimal inline script body to apply stored color scheme before first paint (no FOUC). */
export function color_scheme_script(storageKey: string): string {
	const safe = JSON.stringify(storageKey);
	return `(function(){try{var p=localStorage.getItem(${safe});var d=p==='dark'||((!p||p==='system')&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`;
}

/** Input interaction modality (`'keyboard'` vs `'pointer'`). */
export type InputModality = 'keyboard' | 'pointer';

let modalityInitialized = false;
let lastModality: InputModality = 'pointer';

function ensureModalityListeners(): void {
	if (modalityInitialized || typeof window === 'undefined') return;
	modalityInitialized = true;
	const onKey = (event: KeyboardEvent) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		lastModality = 'keyboard';
	};
	const onPointer = () => {
		lastModality = 'pointer';
	};
	window.addEventListener('keydown', onKey, true);
	window.addEventListener('pointerdown', onPointer, true);
	window.addEventListener('mousedown', onPointer, true);
}

if (typeof window !== 'undefined') {
	ensureModalityListeners();
}

/** Returns whether the most recent user interaction was keyboard-driven (for focus-visible heuristics). */
export function is_focus_from_keyboard(): boolean {
	ensureModalityListeners();
	return lastModality === 'keyboard';
}

/** Returns the current global input modality (`'keyboard'` or `'pointer'`). */
export function current_modality(): InputModality {
	ensureModalityListeners();
	return lastModality;
}

/**
 * Attachment (`{@attach keep_focus()}`) that prevents `pointerdown` / `mousedown` on a button or
 * toolbar control from stealing DOM focus away from an active text editor or input.
 */
export function keep_focus(): Attachment<HTMLElement> {
	return (el) => {
		const prevent = (event: Event) => {
			event.preventDefault();
		};
		el.addEventListener('pointerdown', prevent);
		el.addEventListener('mousedown', prevent);
		return () => {
			el.removeEventListener('pointerdown', prevent);
			el.removeEventListener('mousedown', prevent);
		};
	};
}

/** Options for `bind_drag_preview`. */
export type DragPreviewOptions = {
	/** Reactive active drag coordinates (`null` when not dragging). */
	readonly point: () => { readonly x: number; readonly y: number } | null;
	/** Offset in px relative to pointer (default `{ x: 12, y: 12 }`). */
	readonly offset?: { readonly x: number; readonly y: number };
};

/**
 * Positions a custom floating drag-ghost element under the pointer without HTML5 drag ghost clipping.
 */
export function bind_drag_preview(options: DragPreviewOptions): Attachment<HTMLElement> {
	const ox = options.offset?.x ?? 12;
	const oy = options.offset?.y ?? 12;
	return (el) => {
		$effect(() => {
			const pt = options.point();
			if (pt === null) {
				el.hidden = true;
				return;
			}
			el.hidden = false;
			el.style.position = 'fixed';
			el.style.pointerEvents = 'none';
			el.style.left = '0px';
			el.style.top = '0px';
			el.style.transform = `translate3d(${Math.round(pt.x + ox)}px, ${Math.round(pt.y + oy)}px, 0)`;
		});
	};
}

/** Options for `create_preview`. */
export type PreviewOptions<T> = {
	/** Committed authoritative value. */
	readonly value: () => T;
	/** Called when a preview is explicitly committed. */
	readonly on_commit: (value: T) => void;
};

/** Return value of `create_preview`. */
export type PreviewState<T> = ReturnType<typeof create_preview<T>>;

/**
 * Holds a live transient pointer-drag/scrub preview value over an authoritative value, with
 * clean `commit()` and `cancel()` transitions.
 */
export function create_preview<T>(options: PreviewOptions<T>) {
	let draft = $state.raw<T | undefined>(undefined);
	let active = $state(false);
	const current = $derived(active && draft !== undefined ? draft : options.value());

	function update(next: T): void {
		draft = next;
		active = true;
	}

	function commit(finalValue?: T): void {
		const target = finalValue !== undefined ? finalValue : active && draft !== undefined ? draft : options.value();
		active = false;
		draft = undefined;
		options.on_commit(target);
	}

	function cancel(): void {
		active = false;
		draft = undefined;
	}

	return {
		get current() {
			return current;
		},
		get previewing() {
			return active;
		},
		update,
		commit,
		cancel
	};
}

/**
 * Race-safe optimistic draft settler: removes keys whose current draft value still equals the
 * snapshot that just committed, while preserving newer edits typed while the save was in flight.
 */
export function settle_draft<T>(
	current: Readonly<Record<string, T>>,
	submitted: Readonly<Record<string, T>>,
	equals: (a: T, b: T) => boolean = Object.is
): Record<string, T> {
	const remaining: Record<string, T> = {};
	for (const [key, val] of Object.entries(current)) {
		if (!Object.hasOwn(submitted, key)) {
			remaining[key] = val;
			continue;
		}
		const sent = submitted[key];
		if (sent === undefined || !equals(val, sent)) {
			remaining[key] = val;
		}
	}
	return remaining;
}

/** Options for `create_cookie_storage`. */
export type CookieStorageOptions = {
	readonly path?: string;
	readonly max_age?: number;
	readonly same_site?: 'Lax' | 'Strict' | 'None';
	readonly secure?: boolean;
};

/** Simple browser cookie storage adapter (`get`, `set`, `remove`) for SSR-readable UI preferences. */
export function create_cookie_storage(options: CookieStorageOptions = {}) {
	const path = options.path ?? '/';
	const maxAge = options.max_age ?? 60 * 60 * 24 * 365;
	const sameSite = options.same_site ?? 'Lax';

	function get(name: string): string | null {
		if (typeof document === 'undefined') return null;
		const prefix = `${encodeURIComponent(name)}=`;
		for (const part of document.cookie.split(';')) {
			const trimmed = part.trim();
			if (trimmed.startsWith(prefix)) {
				try {
					return decodeURIComponent(trimmed.slice(prefix.length));
				} catch {
					return trimmed.slice(prefix.length);
				}
			}
		}
		return null;
	}

	function set(name: string, value: string): void {
		if (typeof document === 'undefined') return;
		const attrs = [
			`${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
			`Path=${path}`,
			`Max-Age=${maxAge}`,
			`SameSite=${sameSite}`
		];
		if (options.secure) attrs.push('Secure');
		document.cookie = attrs.join('; ');
	}

	function remove(name: string): void {
		if (typeof document === 'undefined') return;
		document.cookie = `${encodeURIComponent(name)}=; Path=${path}; Max-Age=0; SameSite=${sameSite}`;
	}

	return { get, set, remove };
}

/** One entry in an imperative `create_overlay_stack`. */
export type OverlayEntry<Payload, Result = unknown> = {
	readonly id: string;
	readonly payload: Payload;
	readonly resolve: (result: Result | undefined) => void;
};

/**
 * Imperative LIFO overlay/modal stack manager: `open(payload)` returns a Promise that settles
 * when `close(id, result)` or `Escape` dismisses that overlay layer.
 */
export function create_overlay_stack<Payload, Result = unknown>() {
	let seq = 0;
	let stack = $state.raw<readonly OverlayEntry<Payload, Result>[]>([]);

	function close(id: string, result?: Result): void {
		const entry = stack.find((item) => item.id === id);
		if (entry === undefined) return;
		stack = stack.filter((item) => item.id !== id);
		entry.resolve(result);
	}

	function close_top(result?: Result): void {
		const top = stack.at(-1);
		if (top !== undefined) close(top.id, result);
	}

	function close_all(): void {
		const items = stack;
		stack = [];
		for (let i = items.length - 1; i >= 0; i--) {
			items[i]?.resolve(undefined);
		}
	}

	function open(payload: Payload): { readonly id: string; readonly promise: Promise<Result | undefined> } {
		const id = `overlay-${++seq}`;
		let resolveEntry: (value: Result | undefined) => void = () => {};
		const promise = new Promise<Result | undefined>((resolve) => {
			resolveEntry = resolve;
		});
		stack = [...stack, { id, payload, resolve: resolveEntry }];
		return { id, promise };
	}

	create_dismiss({
		open: () => stack.length > 0,
		escape: true,
		outside: false,
		on_dismiss: () => close_top(undefined)
	});

	return {
		get stack() {
			return stack;
		},
		get top() {
			return stack.at(-1) ?? null;
		},
		get count() {
			return stack.length;
		},
		open,
		close,
		close_top,
		close_all
	};
}
