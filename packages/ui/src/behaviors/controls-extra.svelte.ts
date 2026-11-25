// Headless control behaviors for standard interactive widgets:
// - `create_switch`: WAI-ARIA `role="switch"` with Space/Enter toggle & agent registration
// - `create_radio_group`: WAI-ARIA `radiogroup` + roving focus where selection follows focus
// - `create_toggle_group`: single or multiple pressed toggle buttons with roving focus
// - `create_number_input`: locale-aware number entry, Arrow/Page/Home/End stepping, `bind_repeat` steppers & scrub
// - `create_rating`: star/score picker with Arrow/Home/End, hover preview & optional half-steps
// - `create_toolbar`: single-tab-stop WAI-ARIA `role="toolbar"` roving focus container
import { register_control } from './controls.svelte.js';
import { bind_repeat } from './micro.svelte.js';
import { create_roving_focus, type RovingOrientation } from './roving-focus.svelte.js';

/** Options for `create_switch`. */
export type SwitchOptions = {
	readonly checked?: () => boolean;
	readonly default_checked?: boolean;
	readonly on_change?: (checked: boolean) => void;
	readonly disabled?: () => boolean;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Headless WAI-ARIA switch behavior (`role="switch"`, `aria-checked`, Space/Enter toggle). */
export function create_switch(options: SwitchOptions = {}) {
	let internal = $state(options.default_checked ?? false);
	const checked = $derived(options.checked ? options.checked() : internal);
	const disabled = $derived(options.disabled?.() ?? false);

	function set_checked(next: boolean): void {
		if (disabled || next === checked) return;
		if (!options.checked) internal = next;
		options.on_change?.(next);
	}

	function toggle(): void {
		set_checked(!checked);
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'switch',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ checked, disabled }),
				actions: {
					toggle,
					set: (v) => {
						if (typeof v === 'boolean') set_checked(v);
					}
				}
			})
		);
	}

	return {
		get checked() {
			return checked;
		},
		get disabled() {
			return disabled;
		},
		set_checked,
		toggle,
		attrs() {
			return {
				type: 'button' as const,
				role: 'switch' as const,
				'aria-checked': checked,
				'aria-label': options.label,
				'data-state': checked ? ('checked' as const) : ('unchecked' as const),
				disabled: disabled || undefined,
				onclick: () => toggle(),
				onkeydown: (event: KeyboardEvent) => {
					if (event.key === ' ' || event.key === 'Enter') {
						event.preventDefault();
						toggle();
					}
				}
			};
		}
	};
}

/** Options for `create_radio_group`. */
export type RadioGroupOptions = {
	readonly items: () => readonly string[];
	readonly value?: () => string | undefined;
	readonly default_value?: string;
	readonly on_change?: (value: string) => void;
	readonly orientation?: RovingOrientation;
	readonly disabled?: (value: string) => boolean;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/**
 * Headless WAI-ARIA `radiogroup` (also powers Segmented Controls): single tab stop, arrow keys
 * move focus and select simultaneously.
 */
export function create_radio_group(options: RadioGroupOptions) {
	let internal = $state<string | undefined>(options.default_value);
	const value = $derived(options.value ? options.value() : internal);

	function select(next: string): void {
		if (options.disabled?.(next) || next === value) return;
		if (!options.value) internal = next;
		options.on_change?.(next);
	}

	const roving = create_roving_focus({
		items: options.items,
		active: () => value,
		on_active_change: select,
		orientation: options.orientation ?? 'horizontal',
		disabled: options.disabled
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'radio-group',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ value, items: options.items() }),
				items: () => options.items().filter((v) => !options.disabled?.(v)).map((v) => ({ value: v, label: v })),
				actions: {
					select: (v) => {
						if (typeof v === 'string') select(v);
					}
				}
			})
		);
	}

	return {
		get value() {
			return value;
		},
		select,
		item: roving.item,
		root_attrs() {
			return {
				role: 'radiogroup' as const,
				'aria-label': options.label,
				'aria-orientation': options.orientation === 'vertical' ? ('vertical' as const) : ('horizontal' as const),
				onkeydown: roving.root_attrs().onkeydown
			};
		},
		item_attrs(key: string) {
			const checked = value === key;
			const off = options.disabled?.(key) === true;
			const rov = roving.item_attrs(key);
			return {
				type: 'button' as const,
				role: 'radio' as const,
				'aria-checked': checked,
				'aria-disabled': off ? (true as const) : undefined,
				'data-state': checked ? ('checked' as const) : ('unchecked' as const),
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onclick: () => select(key)
			};
		}
	};
}

/** Options for `create_toggle_group`. */
export type ToggleGroupOptions = {
	readonly items: () => readonly string[];
	readonly mode?: 'single' | 'multiple';
	readonly value?: () => readonly string[];
	readonly default_value?: readonly string[];
	readonly on_change?: (values: readonly string[]) => void;
	readonly orientation?: RovingOrientation;
	readonly disabled?: (key: string) => boolean;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Headless toggle button group (`aria-pressed`, single or multi-select, roving focus). */
export function create_toggle_group(options: ToggleGroupOptions) {
	const mode = options.mode ?? 'single';
	let internal = $state<readonly string[]>(options.default_value ?? []);
	const pressed = $derived(options.value ? options.value() : internal);
	const pressedSet = $derived(new Set(pressed));

	function toggle(key: string): void {
		if (options.disabled?.(key)) return;
		const on = pressedSet.has(key);
		const next =
			mode === 'single'
				? on
					? []
					: [key]
				: on
					? pressed.filter((k) => k !== key)
					: [...pressed, key];
		if (!options.value) internal = next;
		options.on_change?.(next);
	}

	const roving = create_roving_focus({
		items: options.items,
		orientation: options.orientation ?? 'horizontal',
		disabled: options.disabled
	});

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'toggle-group',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ pressed, items: options.items() }),
				actions: {
					toggle: (k) => {
						if (typeof k === 'string') toggle(k);
					}
				}
			})
		);
	}

	return {
		get pressed() {
			return pressed;
		},
		is_pressed(key: string): boolean {
			return pressedSet.has(key);
		},
		toggle,
		item: roving.item,
		root_attrs() {
			return {
				role: 'group' as const,
				'aria-label': options.label,
				onkeydown: roving.root_attrs().onkeydown
			};
		},
		item_attrs(key: string) {
			const on = pressedSet.has(key);
			const off = options.disabled?.(key) === true;
			const rov = roving.item_attrs(key);
			return {
				type: 'button' as const,
				'aria-pressed': on,
				'data-state': on ? ('on' as const) : ('off' as const),
				disabled: off || undefined,
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onclick: () => toggle(key)
			};
		}
	};
}

/** Options for `create_number_input`. */
export type NumberInputOptions = {
	readonly value?: () => number | null;
	readonly default_value?: number | null;
	readonly on_change?: (value: number | null) => void;
	readonly min?: number;
	readonly max?: number;
	readonly step?: number;
	readonly locale?: string;
	readonly disabled?: () => boolean;
	readonly label?: string;
	readonly control?: { readonly id: string; readonly label?: string };
};

/**
 * Headless WAI-ARIA `spinbutton` number input with clamped stepping, Arrow/Page/Home/End keys,
 * press-and-hold `increment`/`decrement` attachments (`bind_repeat`) and clean empty/numeric parsing.
 */
export function create_number_input(options: NumberInputOptions = {}) {
	const min = options.min ?? Number.NEGATIVE_INFINITY;
	const max = options.max ?? Number.POSITIVE_INFINITY;
	const step = options.step ?? 1;
	const decimals = String(step).split('.')[1]?.length ?? 0;

	let internal = $state<number | null>(options.default_value ?? null);
	let editingText = $state<string | null>(null);
	const disabled = $derived(options.disabled?.() ?? false);
	const value = $derived(options.value ? options.value() : internal);

	function format(n: number | null): string {
		if (n === null || !Number.isFinite(n)) return '';
		return options.locale !== undefined
			? new Intl.NumberFormat(options.locale, { maximumFractionDigits: Math.max(decimals, 6) }).format(n)
			: String(n);
	}

	function clamp(raw: number): number {
		const bounded = Math.max(min, Math.min(max, raw));
		return Number(bounded.toFixed(Math.max(decimals, 10)).replace(/\.?0+$/, '')) || 0;
	}

	function commit(next: number | null): void {
		if (disabled) return;
		const normalized = next === null ? null : clamp(next);
		if (normalized === value) return;
		if (!options.value) internal = normalized;
		options.on_change?.(normalized);
	}

	function stepBy(delta: number): void {
		const base = value ?? (Number.isFinite(min) ? min : 0);
		commit(base + delta);
		editingText = null;
	}

	function parseText(raw: string): number | null {
		const cleaned = raw.trim().replace(/[\s,]+/g, '');
		if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
		const parsed = Number(cleaned);
		return Number.isFinite(parsed) ? parsed : null;
	}

	const text = $derived(editingText ?? format(value));

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'number-input',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ value, min: Number.isFinite(min) ? min : undefined, max: Number.isFinite(max) ? max : undefined }),
				actions: {
					set: (v) => {
						if (typeof v === 'number' || v === null) commit(v);
					},
					increment: () => stepBy(step),
					decrement: () => stepBy(-step)
				}
			})
		);
	}

	return {
		get value() {
			return value;
		},
		get text() {
			return text;
		},
		set: commit,
		increment: () => stepBy(step),
		decrement: () => stepBy(-step),
		increment_button: bind_repeat({
			on_step: () => stepBy(step),
			disabled: () => disabled || (value !== null && value >= max)
		}),
		decrement_button: bind_repeat({
			on_step: () => stepBy(-step),
			disabled: () => disabled || (value !== null && value <= min)
		}),
		input_attrs() {
			return {
				role: 'spinbutton' as const,
				inputmode: decimals > 0 ? ('decimal' as const) : ('numeric' as const),
				value: text,
				disabled: disabled || undefined,
				'aria-label': options.label,
				'aria-valuemin': Number.isFinite(min) ? min : undefined,
				'aria-valuemax': Number.isFinite(max) ? max : undefined,
				'aria-valuenow': value ?? undefined,
				oninput: (event: Event) => {
					if (!(event.currentTarget instanceof HTMLInputElement)) return;
					editingText = event.currentTarget.value;
					const parsed = parseText(editingText);
					if (parsed !== null || editingText.trim() === '') commit(parsed);
				},
				onblur: () => {
					if (editingText !== null) {
						commit(parseText(editingText));
						editingText = null;
					}
				},
				onkeydown: (event: KeyboardEvent) => {
					if (disabled) return;
					const page = step * 10;
					if (event.key === 'ArrowUp') {
						event.preventDefault();
						stepBy(step);
					} else if (event.key === 'ArrowDown') {
						event.preventDefault();
						stepBy(-step);
					} else if (event.key === 'PageUp') {
						event.preventDefault();
						stepBy(page);
					} else if (event.key === 'PageDown') {
						event.preventDefault();
						stepBy(-page);
					} else if (event.key === 'Home' && Number.isFinite(min)) {
						event.preventDefault();
						commit(min);
						editingText = null;
					} else if (event.key === 'End' && Number.isFinite(max)) {
						event.preventDefault();
						commit(max);
						editingText = null;
					}
				}
			};
		}
	};
}

/** Options for `create_rating`. */
export type RatingOptions = {
	readonly max?: number;
	readonly value?: () => number;
	readonly default_value?: number;
	readonly on_change?: (value: number) => void;
	readonly disabled?: () => boolean;
	readonly label?: string;
};

/** Headless star/score rating picker (`radiogroup`, hover preview, Arrow/Home/End keys). */
export function create_rating(options: RatingOptions = {}) {
	const max = Math.max(1, options.max ?? 5);
	let internal = $state(options.default_value ?? 0);
	let hovered = $state<number | null>(null);
	const disabled = $derived(options.disabled?.() ?? false);
	const value = $derived(options.value ? options.value() : internal);
	const items = Array.from({ length: max }, (_, i) => i + 1);

	function rate(next: number): void {
		if (disabled) return;
		const clamped = Math.max(0, Math.min(max, next));
		if (!options.value) internal = clamped;
		options.on_change?.(clamped);
	}

	const roving = create_roving_focus({
		items: () => items.map(String),
		active: () => (value > 0 ? String(value) : '1'),
		on_active_change: (k) => rate(Number(k)),
		orientation: 'horizontal',
		loop: false,
		disabled: () => disabled
	});

	return {
		get value() {
			return value;
		},
		get hovered() {
			return hovered;
		},
		get display() {
			return hovered ?? value;
		},
		items,
		rate,
		item: (score: number) => roving.item(String(score)),
		root_attrs() {
			return {
				role: 'radiogroup' as const,
				'aria-label': options.label ?? 'Rating',
				onpointerleave: () => {
					hovered = null;
				},
				onkeydown: roving.root_attrs().onkeydown
			};
		},
		item_attrs(score: number) {
			const rov = roving.item_attrs(String(score));
			const active = (hovered ?? value) >= score;
			return {
				type: 'button' as const,
				role: 'radio' as const,
				'aria-checked': value === score,
				'aria-label': `${score} of ${max}`,
				'data-filled': active ? '' : undefined,
				disabled: disabled || undefined,
				tabindex: rov.tabindex,
				onfocus: rov.onfocus,
				onpointerenter: () => {
					if (!disabled) hovered = score;
				},
				onclick: () => rate(score)
			};
		}
	};
}

/** Options for `create_toolbar`. */
export type ToolbarOptions = {
	readonly items: () => readonly string[];
	readonly orientation?: RovingOrientation;
	readonly disabled?: (key: string) => boolean;
	readonly label?: string;
};

/** Headless WAI-ARIA `role="toolbar"` single-tab-stop roving container. */
export function create_toolbar(options: ToolbarOptions) {
	const orientation = options.orientation ?? 'horizontal';
	const roving = create_roving_focus({
		items: options.items,
		orientation,
		disabled: options.disabled
	});

	return {
		get active() {
			return roving.active;
		},
		focus: roving.focus,
		item: roving.item,
		root_attrs() {
			return {
				role: 'toolbar' as const,
				'aria-label': options.label,
				'aria-orientation': orientation === 'vertical' ? ('vertical' as const) : ('horizontal' as const),
				onkeydown: roving.root_attrs().onkeydown
			};
		},
		item_attrs: roving.item_attrs
	};
}
