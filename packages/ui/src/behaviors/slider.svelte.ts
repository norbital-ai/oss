// Composable slider / scrubber behavior: single-thumb or multi-thumb range, horizontal or vertical
// orientation, RTL support, pointer drag + keyboard Arrow/Page/Home/End, live `on_change` vs
// settled `on_commit` and optional live agent control registration.
import type { Attachment } from 'svelte/attachments';
import { register_control } from './controls.svelte.js';

/** Options for `create_slider`. */
export type SliderOptions = {
	/** Controlled numeric value (single-thumb mode); omit for internal state. */
	readonly value?: () => number;
	/** Initial value when uncontrolled (default `min`). */
	readonly default_value?: number;
	/** Called when the quantized value changes (single-thumb mode). */
	readonly on_change?: (value: number) => void;
	/** Called once when a drag or key adjustment settles (single-thumb mode). */
	readonly on_commit?: (value: number) => void;
	/** Controlled multi-thumb values (range slider mode). */
	readonly values?: () => readonly number[];
	/** Initial multi-thumb values when uncontrolled. */
	readonly default_values?: readonly number[];
	/** Called when multi-thumb values change. */
	readonly on_values_change?: (values: readonly number[]) => void;
	/** Called once when a multi-thumb drag or key adjustment settles. */
	readonly on_values_commit?: (values: readonly number[]) => void;
	/** Minimum value (default `0`). */
	readonly min?: number | (() => number);
	/** Maximum value (default `100`). */
	readonly max?: number | (() => number);
	/** Step increment (default `1`). */
	readonly step?: number | (() => number);
	/** Orientation (`'horizontal'` default, or `'vertical'`). */
	readonly orientation?: 'horizontal' | 'vertical';
	/** Disabled state. */
	readonly disabled?: () => boolean;
	/** Accessible label. */
	readonly label?: string;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	readonly control?: { readonly id: string; readonly label?: string };
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
 * Headless single- or multi-thumb slider behavior (`track` attachment + `thumb_attrs(index?)`).
 */
export function create_slider(options: SliderOptions = {}) {
	const min = $derived(typeof options.min === 'function' ? options.min() : (options.min ?? 0));
	const max = $derived(typeof options.max === 'function' ? options.max() : (options.max ?? 100));
	const step = $derived(typeof options.step === 'function' ? options.step() : (options.step ?? 1));
	const orientation = options.orientation ?? 'horizontal';
	const rangeMode = options.values !== undefined || options.default_values !== undefined;

	const initMin = typeof options.min === 'function' ? options.min() : (options.min ?? 0);
	const initMax = typeof options.max === 'function' ? options.max() : (options.max ?? 100);
	const initStep = typeof options.step === 'function' ? options.step() : (options.step ?? 1);
	let internalSingle = $state(quantize(options.default_value ?? initMin, initMin, initMax, initStep));
	let internalMulti = $state<readonly number[]>(
		(options.default_values ?? [initMin, initMax]).map((v) => quantize(v, initMin, initMax, initStep))
	);
	let dragging = $state(false);
	let activeThumb = $state(0);
	let trackEl: HTMLElement | null = null;

	const disabled = $derived(options.disabled?.() ?? false);
	const values = $derived<readonly number[]>(
		rangeMode
			? (options.values ? options.values() : internalMulti).map((v) => quantize(v, min, max, step))
			: [quantize(options.value ? options.value() : internalSingle, min, max, step)]
	);
	const value = $derived(values[0] ?? min);
	const toPercent = (v: number) => (max === min ? 0 : ((v - min) / (max - min)) * 100);
	const percent = $derived(toPercent(value));
	const percents = $derived(values.map(toPercent));

	function commitThumb(index: number, raw: number, settle = false): void {
		if (disabled) return;
		const idx = Math.max(0, Math.min(values.length - 1, index));
		let next = quantize(raw, min, max, step);
		if (rangeMode) {
			const lower = idx > 0 ? (values[idx - 1] ?? min) : min;
			const upper = idx < values.length - 1 ? (values[idx + 1] ?? max) : max;
			next = Math.max(lower, Math.min(upper, next));
			const updated = values.map((v, i) => (i === idx ? next : v));
			const changed = updated.some((v, i) => v !== values[i]);
			if (changed) {
				if (!options.values) internalMulti = updated;
				options.on_values_change?.(updated);
			}
			if (settle) options.on_values_commit?.(updated);
			return;
		}
		if (next !== value) {
			if (!options.value) internalSingle = next;
			options.on_change?.(next);
		}
		if (settle) options.on_commit?.(next);
	}

	function valueFromPointer(event: PointerEvent): number | null {
		if (trackEl === null) return null;
		const rect = trackEl.getBoundingClientRect();
		if (orientation === 'vertical') {
			if (rect.height <= 0) return null;
			const ratio = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
			return min + ratio * (max - min);
		}
		if (rect.width <= 0) return null;
		const rtl = getComputedStyle(trackEl).direction === 'rtl';
		const rawRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
		const ratio = rtl ? 1 - rawRatio : rawRatio;
		return min + ratio * (max - min);
	}

	function nearestThumb(target: number): number {
		if (!rangeMode || values.length <= 1) return 0;
		let best = 0;
		let bestDist = Number.POSITIVE_INFINITY;
		for (let i = 0; i < values.length; i++) {
			const d = Math.abs((values[i] ?? min) - target);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		}
		return best;
	}

	function onpointerdown(event: PointerEvent): void {
		if (disabled || event.button !== 0) return;
		event.preventDefault();
		const initial = valueFromPointer(event);
		if (initial === null) return;
		const thumb = nearestThumb(initial);
		activeThumb = thumb;
		dragging = true;
		commitThumb(thumb, initial, false);

		const move = (m: PointerEvent) => {
			const v = valueFromPointer(m);
			if (v !== null) commitThumb(thumb, v, false);
		};
		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			dragging = false;
			commitThumb(thumb, values[thumb] ?? min, true);
		};
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}

	function handleKeydown(index: number, event: KeyboardEvent): void {
		if (disabled) return;
		const rtl =
			orientation === 'horizontal' &&
			event.currentTarget instanceof HTMLElement &&
			getComputedStyle(event.currentTarget).direction === 'rtl';
		const dir = rtl ? -1 : 1;
		const cur = values[index] ?? min;
		const page = step * 10;

		switch (event.key) {
			case 'ArrowRight':
				event.preventDefault();
				commitThumb(index, cur + step * dir, true);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				commitThumb(index, cur - step * dir, true);
				break;
			case 'ArrowUp':
				event.preventDefault();
				commitThumb(index, cur + step, true);
				break;
			case 'ArrowDown':
				event.preventDefault();
				commitThumb(index, cur - step, true);
				break;
			case 'PageUp':
				event.preventDefault();
				commitThumb(index, cur + page, true);
				break;
			case 'PageDown':
				event.preventDefault();
				commitThumb(index, cur - page, true);
				break;
			case 'Home':
				event.preventDefault();
				commitThumb(index, min, true);
				break;
			case 'End':
				event.preventDefault();
				commitThumb(index, max, true);
				break;
		}
	}

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'slider',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				state: () => ({ ...(rangeMode ? { values } : { value }), min, max }),
				actions: {
					set: (v, idx) => {
						if (typeof v === 'number') commitThumb(typeof idx === 'number' ? idx : 0, v, true);
					}
				}
			})
		);
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
		get values() {
			return values;
		},
		get percent() {
			return percent;
		},
		get percents() {
			return percents;
		},
		get dragging() {
			return dragging;
		},
		get active_thumb() {
			return activeThumb;
		},
		set(next: number, index = 0) {
			commitThumb(index, next, true);
		},
		track,
		thumb_attrs(index = 0) {
			const val = values[index] ?? min;
			const lower = rangeMode && index > 0 ? (values[index - 1] ?? min) : min;
			const upper = rangeMode && index < values.length - 1 ? (values[index + 1] ?? max) : max;
			return {
				role: 'slider' as const,
				'aria-orientation': orientation,
				'aria-label': options.label,
				'aria-valuemin': lower,
				'aria-valuemax': upper,
				'aria-valuenow': val,
				'aria-disabled': disabled ? (true as const) : undefined,
				tabindex: disabled ? undefined : 0,
				'data-dragging': dragging && activeThumb === index ? '' : undefined,
				onfocus: () => {
					activeThumb = index;
				},
				onkeydown: (event: KeyboardEvent) => handleKeydown(index, event)
			};
		}
	};
}
