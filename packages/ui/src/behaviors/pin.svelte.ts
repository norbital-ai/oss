// Composable OTP / PIN cell behavior backed by one hidden/accessible native input for autofill,
// paste, keyboard selection and per-cell rendering without focus juggling.

/** One visual cell of a PIN / OTP code. */
export type PinCell = {
	/** Zero-based index of this cell. */
	readonly index: number;
	/** Character currently in this cell, or `null` when empty. */
	readonly char: string | null;
	/** Whether this cell holds the active caret position. */
	readonly is_active: boolean;
	/** Whether to draw a blinking caret inside this empty active cell. */
	readonly has_fake_caret: boolean;
};

/** Options for `create_pin_input`. */
export type PinInputOptions = {
	/** Number of cells (e.g. `6`). */
	readonly length: number | (() => number);
	/** Controlled value getter; omit for internal state. */
	readonly value?: () => string;
	/** Initial value when uncontrolled. */
	readonly default_value?: string;
	/** Called whenever the sanitized value changes. */
	readonly on_value_change?: (value: string) => void;
	/** Called when the value reaches `length` characters. */
	readonly on_complete?: (value: string) => void;
	/** Allowed character filter regex (default digits only `/^\d+$/`). */
	readonly pattern?: RegExp;
	/** Disabled state. */
	readonly disabled?: () => boolean;
};

/** Return value of `create_pin_input`. */
export type PinInputBehavior = ReturnType<typeof create_pin_input>;

/**
 * Headless PIN / OTP input behavior exposing reactive `cells`, `value` and native `input_attrs()`.
 */
export function create_pin_input(options: PinInputOptions) {
	let internal = $state(options.default_value ?? '');
	let focused = $state(false);
	let caret = $state(0);

	const maxLength = $derived(typeof options.length === 'function' ? options.length() : options.length);
	const disabled = $derived(options.disabled?.() ?? false);
	const value = $derived(options.value ? options.value() : internal);

	function sanitize(raw: string): string {
		const pattern = options.pattern;
		let cleaned = raw;
		if (pattern !== undefined) {
			cleaned = [...raw].filter((ch) => pattern.test(ch)).join('');
		}
		return cleaned.slice(0, maxLength);
	}

	function setValue(raw: string): void {
		if (disabled) return;
		const next = sanitize(raw);
		if (next === value) return;
		if (!options.value) internal = next;
		options.on_value_change?.(next);
		if (next.length === maxLength) options.on_complete?.(next);
	}

	const cells = $derived.by((): readonly PinCell[] => {
		const activeIndex = focused ? Math.min(caret, Math.max(0, maxLength - 1)) : -1;
		return Array.from({ length: maxLength }, (_, index) => {
			const char = value[index] ?? null;
			const is_active = index === activeIndex;
			return {
				index,
				char,
				is_active,
				has_fake_caret: is_active && char === null
			};
		});
	});

	function syncCaret(el: HTMLInputElement): void {
		const pos = el.selectionStart ?? el.value.length;
		caret = Math.min(pos, value.length);
	}

	return {
		get value() {
			return value;
		},
		get cells() {
			return cells;
		},
		get focused() {
			return focused;
		},
		set_value: setValue,
		/** Spread onto the underlying `<input>` element that owns focus, typing, paste and autofill. */
		input_attrs() {
			return {
				value,
				maxlength: maxLength,
				disabled: disabled || undefined,
				onfocus: (event: FocusEvent) => {
					focused = true;
					if (event.currentTarget instanceof HTMLInputElement) {
						const end = value.length;
						event.currentTarget.setSelectionRange(end, end);
						caret = end;
					}
				},
				onblur: () => {
					focused = false;
				},
				oninput: (event: Event) => {
					if (!(event.currentTarget instanceof HTMLInputElement)) return;
					const next = sanitize(event.currentTarget.value);
					if (event.currentTarget.value !== next) event.currentTarget.value = next;
					setValue(next);
					caret = Math.min(event.currentTarget.selectionStart ?? next.length, maxLength - 1);
				},
				onkeyup: (event: KeyboardEvent) => {
					if (event.currentTarget instanceof HTMLInputElement) syncCaret(event.currentTarget);
				},
				onselect: (event: Event) => {
					if (event.currentTarget instanceof HTMLInputElement) syncCaret(event.currentTarget);
				}
			};
		}
	};
}
