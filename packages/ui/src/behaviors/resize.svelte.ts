// Pointer + keyboard resizing behavior for split panes, drawers, sheets and table columns.
// Handles min/max clamping, inverted direction (e.g. resizing a right-anchored panel from its left
// edge), cursor lock and Arrow-key nudging with `role="separator"` ARIA attributes.

/** Axis of pointer/keyboard resizing (`'horizontal'` or `'vertical'`). */
export type ResizeAxis = 'horizontal' | 'vertical';

/** Options for `create_resize`. */
export type ResizeOptions = {
	/** Current size in pixels (reactive getter). */
	value: () => number;
	/** Called with the clamped pixel size during drag and keyboard nudges. */
	on_change: (next: number) => void;
	/** Called once when a pointer drag finishes. */
	on_commit?: (final: number) => void;
	/** Axis of drag movement (default `'horizontal'`). */
	axis?: ResizeAxis;
	/** Invert drag delta (e.g. dragging a right-docked sheet's left edge leftward widens it). */
	invert?: boolean;
	/** Minimum size in pixels (default `120`). */
	min?: number | (() => number);
	/** Maximum size in pixels (default `Infinity`). */
	max?: number | (() => number);
	/** Keyboard Arrow nudge increment in pixels (default `24`). */
	step?: number;
	/** Accessible label for the separator handle. */
	label?: string;
};

/** Return value of `create_resize`. */
export type Resize = ReturnType<typeof create_resize>;

/**
 * Headless pointer + keyboard resize handle behavior (`handle_attrs()`).
 * @example
 * let width = $state(320);
 * const resize = create_resize({
 *   value: () => width,
 *   min: 220,
 *   max: 560,
 *   on_change: (next) => (width = next)
 * });
 * // <div {...resize.handle_attrs()} class="w-1 cursor-ew-resize bg-border-subtle" />
 */
export function create_resize(options: ResizeOptions) {
	let dragging = $state(false);
	const axis = options.axis ?? 'horizontal';
	const step = options.step ?? 24;
	const sign = options.invert ? -1 : 1;

	const minOf = () => (typeof options.min === 'function' ? options.min() : (options.min ?? 120));
	const maxOf = () =>
		typeof options.max === 'function' ? options.max() : (options.max ?? Number.POSITIVE_INFINITY);
	const clamp = (value: number) => Math.round(Math.min(Math.max(value, minOf()), maxOf()));

	function onpointerdown(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		const startCoord = axis === 'horizontal' ? event.clientX : event.clientY;
		const startSize = options.value();
		let latest = startSize;
		dragging = true;

		const move = (m: PointerEvent) => {
			const coord = axis === 'horizontal' ? m.clientX : m.clientY;
			latest = clamp(startSize + (coord - startCoord) * sign);
			options.on_change(latest);
		};

		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			dragging = false;
			options.on_commit?.(latest);
		};

		document.body.style.cursor = axis === 'horizontal' ? 'ew-resize' : 'ns-resize';
		document.body.style.userSelect = 'none';
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}

	function onkeydown(event: KeyboardEvent): void {
		const decKey = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
		const incKey = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
		if (event.key !== decKey && event.key !== incKey) return;
		event.preventDefault();
		const delta = (event.key === incKey ? step : -step) * sign;
		const next = clamp(options.value() + delta);
		options.on_change(next);
		options.on_commit?.(next);
	}

	return {
		get dragging() {
			return dragging;
		},
		/** Spread onto the resize handle element (`role="separator"`, `aria-value*`, pointer & keyboard handlers). */
		handle_attrs() {
			const max = maxOf();
			return {
				role: 'separator' as const,
				'aria-orientation': axis === 'horizontal' ? ('vertical' as const) : ('horizontal' as const),
				'aria-label': options.label,
				'aria-valuenow': Math.round(options.value()),
				'aria-valuemin': Math.round(minOf()),
				'aria-valuemax': Number.isFinite(max) ? Math.round(max) : undefined,
				tabindex: 0,
				'data-dragging': dragging ? '' : undefined,
				onpointerdown,
				onkeydown
			};
		}
	};
}
