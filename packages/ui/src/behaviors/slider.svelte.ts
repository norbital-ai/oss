// Composable slider / scrubber behavior: pointer drag across a track + keyboard Arrow/Page/Home/End
// with min/max/step quantization and full WAI-ARIA slider attributes.
import type { Attachment } from 'svelte/attachments';

/** Options for `create_slider`. */
export type SliderOptions = {
	/** Controlled numeric value; omit for internal state. */
	value?: () => number;
	/** Initial value when uncontrolled (default `min`). */
	default_value?: number;
	/** Called when the quantized value changes. */
	on_change?: (value: number) => void;
	/** Minimum value (default `0`). */
	min?: number;
	/** Maximum value (default `100`). */
	max?: number;
	/** Step increment (default `1`). */
	step?: number;
	/** Disabled state. */
	disabled?: () => boolean;
	/** Accessible label. */
	label?: string;
};

/** Return value of `create_slider`. */
export type Slider = ReturnType<typeof create_slider>;

function quantize(raw: number, min: number, max: number, step: number): number {
	const clamped = Math.min(max, Math.max(min, raw));
	const stepped = Math.round((clamped - min) / step) * step + min;
	const decimals = String(step).split('.')[1]?.length ?? 0;
	return Number(Math.min(max, Math.max(min, stepped)).toFixed(decimals));
}

/**
 * Headless slider behavior (`track` attachment + `thumb_attrs()` + reactive `percent`).
 */
export function create_slider(options: SliderOptions = {}) {
	const min = options.min ?? 0;
	const max = options.max ?? 100;
	const step = options.step ?? 1;
	let internal = $state(quantize(options.default_value ?? min, min, max, step));
	let dragging = $state(false);
	let trackEl: HTMLElement | null = null;

	const disabled = $derived(options.disabled?.() ?? false);
	const value = $derived(quantize(options.value ? options.value() : internal, min, max, step));
	const percent = $derived(max === min ? 0 : ((value - min) / (max - min)) * 100);

	function commit(raw: number): void {
		if (disabled) return;
		const next = quantize(raw, min, max, step);
		if (next === value) return;
		if (!options.value) internal = next;
		options.on_change?.(next);
	}

	function setFromClientX(clientX: number): void {
		if (trackEl === null) return;
		const rect = trackEl.getBoundingClientRect();
		if (rect.width <= 0) return;
		const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		commit(min + ratio * (max - min));
	}

	function onpointerdown(event: PointerEvent): void {
		if (disabled || event.button !== 0) return;
		event.preventDefault();
		dragging = true;
		setFromClientX(event.clientX);

		const move = (m: PointerEvent) => setFromClientX(m.clientX);
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			dragging = false;
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}

	function onkeydown(event: KeyboardEvent): void {
		if (disabled) return;
		const page = step * 10;
		switch (event.key) {
			case 'ArrowRight':
			case 'ArrowUp':
				event.preventDefault();
				commit(value + step);
				break;
			case 'ArrowLeft':
			case 'ArrowDown':
				event.preventDefault();
				commit(value - step);
				break;
			case 'PageUp':
				event.preventDefault();
				commit(value + page);
				break;
			case 'PageDown':
				event.preventDefault();
				commit(value - page);
				break;
			case 'Home':
				event.preventDefault();
				commit(min);
				break;
			case 'End':
				event.preventDefault();
				commit(max);
				break;
		}
	}

	const track: Attachment<HTMLElement> = (el) => {
		trackEl = el;
		el.addEventListener('pointerdown', onpointerdown);
		return () => {
			el.removeEventListener('pointerdown', onpointerdown);
			if (trackEl === el) trackEl = null;
		};
	};

	return {
		get value() {
			return value;
		},
		get percent() {
			return percent;
		},
		get dragging() {
			return dragging;
		},
		set(next: number) {
			commit(next);
		},
		track,
		thumb_attrs() {
			return {
				role: 'slider' as const,
				'aria-label': options.label,
				'aria-valuemin': min,
				'aria-valuemax': max,
				'aria-valuenow': value,
				'aria-disabled': disabled ? (true as const) : undefined,
				tabindex: disabled ? undefined : 0,
				'data-dragging': dragging ? '' : undefined,
				onkeydown
			};
		}
	};
}
