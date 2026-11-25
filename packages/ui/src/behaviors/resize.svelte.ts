// Pointer + keyboard resizing behavior for split panes, drawers, sheets, table columns and 2D frames.
// Handles min/max clamping, inverted edges, zoom scaling, pointer capture, cursor lock and
// Arrow/Shift+Arrow/Home/End keyboard nudging with `role="separator"` ARIA attributes.

/** Axis of pointer/keyboard resizing (`'horizontal'`, `'vertical'`, or 2D `'both'`). */
export type ResizeAxis = 'horizontal' | 'vertical' | 'both';

/** 2D dimensions used when `axis === 'both'` or via `create_resize_2d`. */
export type ResizeBox = { readonly width: number; readonly height: number };

/** Options for `create_resize`. */
export type ResizeOptions = {
	/** Current size in pixels (reactive getter). */
	readonly value: () => number;
	/** Called with the clamped pixel size during drag and keyboard nudges. */
	readonly on_change: (next: number) => void;
	/** Called once when a pointer drag finishes. */
	readonly on_commit?: (final: number) => void;
	/** Axis of drag movement (default `'horizontal'`). */
	readonly axis?: 'horizontal' | 'vertical';
	/** Invert drag delta (e.g. dragging a right-docked sheet's left edge leftward widens it). */
	readonly invert?: boolean;
	/** Minimum size in pixels (default `120`). */
	readonly min?: number | (() => number);
	/** Maximum size in pixels (default `Infinity`). */
	readonly max?: number | (() => number);
	/** Optional zoom divisor for scaled canvases/preview frames (default `1`). */
	readonly scale?: number | (() => number);
	/** Keyboard Arrow nudge increment in pixels (default `24`). */
	readonly step?: number;
	/** Accessible label for the separator handle. */
	readonly label?: string;
};

/** Return value of `create_resize`. */
export type Resize = ReturnType<typeof create_resize>;

/**
 * Headless 1D pointer + keyboard resize handle behavior (`handle_attrs()`).
 */
export function create_resize(options: ResizeOptions) {
	let dragging = $state(false);
	const axis = options.axis ?? 'horizontal';
	const step = options.step ?? 24;
	const sign = options.invert ? -1 : 1;

	const minOf = () => (typeof options.min === 'function' ? options.min() : (options.min ?? 120));
	const maxOf = () =>
		typeof options.max === 'function' ? options.max() : (options.max ?? Number.POSITIVE_INFINITY);
	const scaleOf = () =>
		typeof options.scale === 'function' ? options.scale() : (options.scale ?? 1);
	const clamp = (value: number) => Math.round(Math.min(Math.max(value, minOf()), maxOf()));

	function onpointerdown(event: PointerEvent): void {
		if (event.button !== 0) return;
		event.preventDefault();
		const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		const startCoord = axis === 'horizontal' ? event.clientX : event.clientY;
		const startSize = options.value();
		const zoom = Math.max(0.01, scaleOf());
		let latest = startSize;
		dragging = true;
		try {
			target?.setPointerCapture?.(event.pointerId);
		} catch {
			// Synthetic DOM events without pointer capture.
		}

		const move = (m: PointerEvent) => {
			const coord = axis === 'horizontal' ? m.clientX : m.clientY;
			latest = clamp(startSize + ((coord - startCoord) / zoom) * sign);
			options.on_change(latest);
		};

		const up = () => {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			try {
				if (target?.hasPointerCapture?.(event.pointerId)) target.releasePointerCapture(event.pointerId);
			} catch {
				// Ignore in synthetic DOMs.
			}
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
		if (event.key === 'Home') {
			event.preventDefault();
			const next = clamp(minOf());
			options.on_change(next);
			options.on_commit?.(next);
			return;
		}
		if (event.key === 'End' && Number.isFinite(maxOf())) {
			event.preventDefault();
			const next = clamp(maxOf());
			options.on_change(next);
			options.on_commit?.(next);
			return;
		}
		if (event.key !== decKey && event.key !== incKey) return;
		event.preventDefault();
		const mult = event.shiftKey ? 4 : 1;
		const delta = (event.key === incKey ? step : -step) * mult * sign;
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

/** Options for 2D `create_resize_box` (edge & corner handles for preview frames, cards, canvases). */
export type ResizeBoxOptions = {
	readonly size: () => ResizeBox;
	readonly on_change: (next: ResizeBox) => void;
	readonly on_commit?: (final: ResizeBox) => void;
	readonly min_width?: number;
	readonly max_width?: number;
	readonly min_height?: number;
	readonly max_height?: number;
	readonly scale?: () => number;
	readonly step?: number;
};

/**
 * Headless 2D edge & corner resize behavior supporting `'x'`, `'y'` and `'xy'` handles with zoom scaling.
 */
export function create_resize_box(options: ResizeBoxOptions) {
	let dragging = $state(false);
	const minW = options.min_width ?? 120;
	const maxW = options.max_width ?? Number.POSITIVE_INFINITY;
	const minH = options.min_height ?? 120;
	const maxH = options.max_height ?? Number.POSITIVE_INFINITY;
	const step = options.step ?? 24;

	const clampBox = (w: number, h: number): ResizeBox => ({
		width: Math.round(Math.max(minW, Math.min(maxW, w))),
		height: Math.round(Math.max(minH, Math.min(maxH, h)))
	});

	function handle_attrs(mode: 'x' | 'y' | 'xy', label?: string) {
		return {
			role: 'separator' as const,
			tabindex: 0,
			'aria-label': label,
			'data-dragging': dragging ? '' : undefined,
			onpointerdown: (down: PointerEvent) => {
				if (down.button !== 0) return;
				down.preventDefault();
				const target = down.currentTarget instanceof HTMLElement ? down.currentTarget : null;
				const start = options.size();
				const zoom = Math.max(0.01, options.scale?.() ?? 1);
				let latest = start;
				dragging = true;
				try {
					target?.setPointerCapture?.(down.pointerId);
				} catch {
					// Synthetic DOM events.
				}
				const move = (m: PointerEvent) => {
					const dw = mode === 'y' ? 0 : (m.clientX - down.clientX) / zoom;
					const dh = mode === 'x' ? 0 : (m.clientY - down.clientY) / zoom;
					latest = clampBox(start.width + dw, start.height + dh);
					options.on_change(latest);
				};
				const up = () => {
					window.removeEventListener('pointermove', move);
					window.removeEventListener('pointerup', up);
					window.removeEventListener('pointercancel', up);
					try {
						if (target?.hasPointerCapture?.(down.pointerId)) target.releasePointerCapture(down.pointerId);
					} catch {
						// Ignore.
					}
					dragging = false;
					options.on_commit?.(latest);
				};
				window.addEventListener('pointermove', move);
				window.addEventListener('pointerup', up);
				window.addEventListener('pointercancel', up);
			},
			onkeydown: (event: KeyboardEvent) => {
				const cur = options.size();
				const inc = step * (event.shiftKey ? 4 : 1);
				let next: ResizeBox | null = null;
				if (mode !== 'y' && event.key === 'ArrowRight') next = clampBox(cur.width + inc, cur.height);
				else if (mode !== 'y' && event.key === 'ArrowLeft') next = clampBox(cur.width - inc, cur.height);
				else if (mode !== 'x' && event.key === 'ArrowDown') next = clampBox(cur.width, cur.height + inc);
				else if (mode !== 'x' && event.key === 'ArrowUp') next = clampBox(cur.width, cur.height - inc);
				if (next === null) return;
				event.preventDefault();
				options.on_change(next);
				options.on_commit?.(next);
			}
		};
	}

	return {
		get dragging() {
			return dragging;
		},
		handle_attrs
	};
}
