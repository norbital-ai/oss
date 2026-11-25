// Gesture physics (rubber-band resistance, pointer velocity tracking, snap points, spring step)
// and swipeable snap-point drawer/bottom-sheet behavior (`create_drawer`).
import type { Attachment } from 'svelte/attachments';
import { register_control } from './controls.svelte.js';
import { create_dismiss } from './dismiss.svelte.js';
import { bind_drag } from './drag.svelte.js';
import { create_focus_trap } from './focus-trap.svelte.js';

/** Applies iOS-style asymptotic rubber-band resistance beyond `[0, limit]`. */
export function rubber_band(offset: number, dimension: number, constant = 0.55): number {
	const d = Math.max(1, Math.abs(dimension));
	const sign = offset < 0 ? -1 : 1;
	const abs = Math.abs(offset);
	return (sign * (abs * d * constant)) / (d + constant * abs);
}

/** Exponentially weighted pointer velocity tracker (pixels per millisecond). */
export function create_velocity_tracker() {
	let lastPos: number | null = null;
	let lastTime: number | null = null;
	let vel = 0;

	return {
		add(position: number, time = Date.now()): void {
			if (lastPos !== null && lastTime !== null) {
				const dt = Math.max(1, time - lastTime);
				const inst = (position - lastPos) / dt;
				vel = vel * 0.4 + inst * 0.6;
			}
			lastPos = position;
			lastTime = time;
		},
		velocity(): number {
			return vel;
		},
		reset(): void {
			lastPos = null;
			lastTime = null;
			vel = 0;
		}
	};
}

/** Projects a position using release `velocity` and returns the nearest snap point. */
export function nearest_snap_point(
	position: number,
	velocity: number,
	points: readonly number[],
	options: { readonly projection_ms?: number } = {}
): number {
	const first = points[0];
	if (first === undefined) return position;
	const projected = position + velocity * (options.projection_ms ?? 140);
	let best = first;
	let bestDist = Math.abs(projected - first);
	for (let i = 1; i < points.length; i++) {
		const pt = points[i];
		if (pt === undefined) continue;
		const dist = Math.abs(projected - pt);
		if (dist < bestDist) {
			bestDist = dist;
			best = pt;
		}
	}
	return best;
}

/** Spring state for one-dimensional spring integration. */
export type SpringState = {
	readonly position: number;
	readonly velocity: number;
	readonly settled: boolean;
};

/** Advances a 1D damped harmonic spring by `dt` seconds toward `target`. */
export function step_spring(
	state: { readonly position: number; readonly velocity: number },
	target: number,
	config: { readonly stiffness?: number; readonly damping?: number; readonly mass?: number; readonly precision?: number } = {},
	dt = 1 / 60
): SpringState {
	const k = config.stiffness ?? 320;
	const c = config.damping ?? 32;
	const m = config.mass ?? 1;
	const eps = config.precision ?? 0.5;
	const force = -k * (state.position - target) - c * state.velocity;
	const accel = force / m;
	const velocity = state.velocity + accel * dt;
	const position = state.position + velocity * dt;
	const settled = Math.abs(position - target) <= eps && Math.abs(velocity) <= eps;
	return settled ? { position: target, velocity: 0, settled: true } : { position, velocity, settled: false };
}

/** Side from which a swipeable drawer slides in. */
export type DrawerSide = 'bottom' | 'top' | 'left' | 'right';

/** Options for `create_drawer`. */
export type DrawerOptions = {
	/** Controlled open state; omit for internal state. */
	readonly open?: () => boolean;
	/** Called when open state changes. */
	readonly on_open_change?: (open: boolean) => void;
	/** Edge the drawer slides from (default `'bottom'`). */
	readonly side?: DrawerSide;
	/** Fractional snap points in `(0, 1]` (default `[1]`, e.g. `[0.4, 0.9]`). */
	readonly snap_points?: readonly number[];
	/** Active snap point index (0-based). */
	readonly active_snap?: () => number;
	/** Called when the active snap point changes. */
	readonly on_snap_change?: (index: number) => void;
	/** Whether dragging past the dismissal threshold closes the drawer (default `true`). */
	readonly dismissible?: boolean;
	/** Trap focus and mark background inert while open (default `true`). */
	readonly modal?: boolean;
	/** Accessible label for the drawer surface. */
	readonly label?: string;
	/** Optional semantic control registration for Norbius's `page` bridge. */
	readonly control?: { readonly id: string; readonly label?: string };
};

/** Return value of `create_drawer`. */
export type DrawerBehavior = ReturnType<typeof create_drawer>;

/**
 * Swipeable snap-point drawer / mobile bottom sheet with rubber-band overdrag, velocity fling
 * dismissal, LIFO Escape/backdrop dismiss, modal focus trap + inert background and control registration.
 */
export function create_drawer(options: DrawerOptions = {}) {
	const side = options.side ?? 'bottom';
	const vertical = side === 'bottom' || side === 'top';
	const dismissSign = side === 'bottom' || side === 'right' ? 1 : -1;
	const snaps = (options.snap_points && options.snap_points.length > 0 ? [...options.snap_points] : [1]).sort(
		(a, b) => a - b
	);
	const dismissible = options.dismissible !== false;

	let internalOpen = $state(false);
	let internalSnap = $state(snaps.length - 1);
	let dragOffset = $state(0);
	let dragging = $state(false);
	let surfaceEl = $state<HTMLElement | null>(null);

	const open = $derived(options.open ? options.open() : internalOpen);
	const snapIndex = $derived(
		Math.max(0, Math.min(snaps.length - 1, options.active_snap ? options.active_snap() : internalSnap))
	);
	const snapFraction = $derived(snaps[snapIndex] ?? 1);

	function setOpen(next: boolean): void {
		if (next === open) return;
		if (!options.open) internalOpen = next;
		dragOffset = 0;
		dragging = false;
		options.on_open_change?.(next);
	}

	function setSnap(idx: number): void {
		const clamped = Math.max(0, Math.min(snaps.length - 1, idx));
		if (!options.active_snap) internalSnap = clamped;
		options.on_snap_change?.(clamped);
	}

	const dismiss = create_dismiss({
		open: () => open,
		escape: dismissible,
		outside: dismissible,
		on_dismiss: () => setOpen(false)
	});

	const trap = create_focus_trap({
		active: () => open,
		modal: () => open && options.modal !== false,
		prevent_scroll: () => open && options.modal !== false,
		topmost: () => dismiss.topmost
	});

	const tracker = create_velocity_tracker();
	let surfaceSize = 400;

	const handle = bind_drag({
		threshold: 4,
		on_start: () => {
			if (!open) return false;
			const rect = surfaceEl?.getBoundingClientRect();
			surfaceSize = Math.max(120, vertical ? (rect?.height ?? 400) : (rect?.width ?? 400));
			tracker.reset();
			dragging = true;
			dragOffset = 0;
			return true;
		},
		on_move: (sample) => {
			const raw = (vertical ? sample.dy : sample.dx) * dismissSign;
			tracker.add(raw);
			// Pulling toward open direction hits rubber-band resistance; pulling toward close tracks 1:1.
			dragOffset = raw < 0 ? rubber_band(raw, surfaceSize * 0.4) * dismissSign : raw * dismissSign;
		},
		on_end: (_event, canceled) => {
			const currentRaw = dragOffset * dismissSign;
			const vel = tracker.velocity();
			dragging = false;
			dragOffset = 0;
			if (canceled) return;

			// Compute effective fraction remaining after drag + momentum projection.
			const projected = currentRaw + vel * 140;
			if (dismissible && (projected > surfaceSize * 0.4 || vel > 0.65)) {
				setOpen(false);
				return;
			}
			if (snaps.length > 1) {
				const curFrac = snapFraction - currentRaw / surfaceSize;
				const nextFrac = nearest_snap_point(curFrac, -vel / surfaceSize, snaps);
				const nextIdx = snaps.indexOf(nextFrac);
				if (nextIdx >= 0) setSnap(nextIdx);
			}
		}
	});

	const surface: Attachment<HTMLElement> = (el) => {
		surfaceEl = el;
		const stopDismiss = dismiss.surface(el);
		const stopTrap = trap.container(el);
		return () => {
			stopTrap?.();
			stopDismiss?.();
			if (surfaceEl === el) surfaceEl = null;
		};
	};

	if (options.control !== undefined) {
		const meta = options.control;
		$effect(() =>
			register_control({
				id: meta.id,
				kind: 'drawer',
				...(meta.label !== undefined ? { label: meta.label } : options.label !== undefined ? { label: options.label } : {}),
				element: () => surfaceEl,
				state: () => ({ open, side, snap: snapFraction }),
				actions: {
					open: () => setOpen(true),
					close: () => setOpen(false),
					snap: (idx) => {
						if (typeof idx === 'number') setSnap(idx);
					}
				}
			})
		);
	}

	return {
		get open() {
			return open;
		},
		get dragging() {
			return dragging;
		},
		get offset() {
			return dragOffset;
		},
		get snap_index() {
			return snapIndex;
		},
		get snap_fraction() {
			return snapFraction;
		},
		set_open: setOpen,
		set_snap: setSnap,
		surface,
		handle,
		surface_attrs() {
			const axisProp = vertical ? 'translateY' : 'translateX';
			return {
				role: 'dialog' as const,
				'aria-modal': options.modal !== false ? (true as const) : undefined,
				'aria-label': options.label,
				'data-side': side,
				'data-dragging': dragging ? '' : undefined,
				'data-state': open ? ('open' as const) : ('closed' as const),
				style: dragOffset !== 0 ? `transform:${axisProp}(${Math.round(dragOffset)}px);` : undefined
			};
		}
	};
}
