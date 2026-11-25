// Hover-intent behavior with safe-polygon pointer corridor (`bridge_between`) and warm-group delay
// sharing for tooltips, hover cards and submenus so diagonal pointer transit never prematurely closes.

type Rect = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;
type Point = readonly [number, number];

function cross(o: Point, a: Point, b: Point): number {
	return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

function convexHull(points: readonly Point[]): Point[] {
	const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
	const lower: Point[] = [];
	for (const p of sorted) {
		while (lower.length >= 2) {
			const a = lower[lower.length - 2];
			const b = lower[lower.length - 1];
			if (a === undefined || b === undefined || cross(a, b, p) > 0) break;
			lower.pop();
		}
		lower.push(p);
	}
	const upper: Point[] = [];
	for (let i = sorted.length - 1; i >= 0; i--) {
		const p = sorted[i];
		if (p === undefined) continue;
		while (upper.length >= 2) {
			const a = upper[upper.length - 2];
			const b = upper[upper.length - 1];
			if (a === undefined || b === undefined || cross(a, b, p) > 0) break;
			upper.pop();
		}
		upper.push(p);
	}
	upper.pop();
	lower.pop();
	return [...lower, ...upper];
}

function pointInConvexPolygon(x: number, y: number, hull: readonly Point[]): boolean {
	if (hull.length < 3) return false;
	for (let i = 0; i < hull.length; i++) {
		const a = hull[i];
		const b = hull[(i + 1) % hull.length];
		if (a === undefined || b === undefined) continue;
		if (cross(a, b, [x, y]) < -1e-6) return false;
	}
	return true;
}

/**
 * Returns a point-in-corridor predicate spanning the convex hull of `trigger` and `popup`
 * (padded slightly so hairline gaps never drop hover during diagonal transit).
 */
export function bridge_between(trigger: Rect, popup: Rect, pad = 4): (x: number, y: number) => boolean {
	const pts: Point[] = [
		[trigger.left - pad, trigger.top - pad],
		[trigger.right + pad, trigger.top - pad],
		[trigger.right + pad, trigger.bottom + pad],
		[trigger.left - pad, trigger.bottom + pad],
		[popup.left - pad, popup.top - pad],
		[popup.right + pad, popup.top - pad],
		[popup.right + pad, popup.bottom + pad],
		[popup.left - pad, popup.bottom + pad]
	];
	const hull = convexHull(pts);
	return (x, y) => pointInConvexPolygon(x, y, hull);
}

type GroupState = {
	active: { close: () => void } | null;
	lastClosedAt: number;
};

const groups = new Map<string, GroupState>();

function groupOf(name: string): GroupState {
	let state = groups.get(name);
	if (state === undefined) {
		state = { active: null, lastClosedAt: 0 };
		groups.set(name, state);
	}
	return state;
}

/** Clears warm-group state (handy between tests). */
export function reset_hover_group(group = 'default'): void {
	groups.delete(group);
}

/** Options for `create_hover_intent`. */
export type HoverIntentOptions = {
	/** Trigger element getter. */
	readonly trigger: () => HTMLElement | null | undefined;
	/** Popup element getter. */
	readonly popup: () => HTMLElement | null | undefined;
	/** Whether the popup is currently open. */
	readonly open: () => boolean;
	/** Opens the popup. */
	readonly on_open: () => void;
	/** Closes the popup. */
	readonly on_close: () => void;
	/** Open delay in ms when cold (default `120`). */
	readonly open_delay?: number | (() => number);
	/** Close delay in ms after leaving the safe corridor (default `80`). */
	readonly close_delay?: number | (() => number);
	/** Shared warm-group key (default `'tooltip'`; pass `null` to opt out). */
	readonly group?: string | null;
	/** Warm window in ms during which sibling hovers open immediately (default `250`). */
	readonly warm_ms?: number;
	/** Allow pointer to travel into popup content without closing (default `true`). */
	readonly hoverable?: boolean | (() => boolean);
};

/** Return value of `create_hover_intent`. */
export type HoverIntent = ReturnType<typeof create_hover_intent>;

/**
 * Headless hover-intent manager with safe-polygon pointer corridor and warm-group delay sharing.
 */
export function create_hover_intent(options: HoverIntentOptions) {
	let openTimer: ReturnType<typeof setTimeout> | undefined;
	let closeTimer: ReturnType<typeof setTimeout> | undefined;
	let stopBridge: (() => void) | null = null;

	const openDelay = () =>
		typeof options.open_delay === 'function' ? options.open_delay() : (options.open_delay ?? 120);
	const closeDelay = () =>
		typeof options.close_delay === 'function' ? options.close_delay() : (options.close_delay ?? 80);
	const hoverable = () =>
		typeof options.hoverable === 'function' ? options.hoverable() : options.hoverable !== false;
	const warmWindow = options.warm_ms ?? 250;
	const groupName = options.group === undefined ? 'tooltip' : options.group;

	const handle = {
		close() {
			clear();
			options.on_close();
		}
	};

	function stopWatching(): void {
		stopBridge?.();
		stopBridge = null;
	}

	function clear(): void {
		if (openTimer !== undefined) {
			clearTimeout(openTimer);
			openTimer = undefined;
		}
		if (closeTimer !== undefined) {
			clearTimeout(closeTimer);
			closeTimer = undefined;
		}
		stopWatching();
	}

	function openNow(): void {
		if (groupName !== null) {
			const g = groupOf(groupName);
			if (g.active !== null && g.active !== handle) g.active.close();
			g.active = handle;
		}
		options.on_open();
	}

	function closeNow(): void {
		if (groupName !== null) {
			const g = groupOf(groupName);
			if (g.active === handle) {
				g.active = null;
				g.lastClosedAt = Date.now();
			}
		}
		options.on_close();
	}

	function scheduleClose(): void {
		stopWatching();
		if (closeTimer !== undefined) clearTimeout(closeTimer);
		const delay = hoverable() ? closeDelay() : 0;
		if (delay <= 0) {
			closeNow();
		} else {
			closeTimer = setTimeout(() => {
				closeTimer = undefined;
				closeNow();
			}, delay);
		}
	}

	function enter(event?: PointerEvent, isTrigger = true): void {
		if (event?.pointerType === 'touch') return;
		if (closeTimer !== undefined) {
			clearTimeout(closeTimer);
			closeTimer = undefined;
		}
		stopWatching();
		if (!isTrigger) return;
		if (openTimer !== undefined) clearTimeout(openTimer);

		const g = groupName !== null ? groupOf(groupName) : null;
		const warm = g !== null && (g.active !== null || Date.now() - g.lastClosedAt < warmWindow);
		const delay = warm ? 0 : openDelay();
		if (delay <= 0) {
			openNow();
		} else {
			openTimer = setTimeout(() => {
				openTimer = undefined;
				openNow();
			}, delay);
		}
	}

	function leave(event?: PointerEvent): void {
		if (event?.pointerType === 'touch') return;
		if (openTimer !== undefined) {
			clearTimeout(openTimer);
			openTimer = undefined;
		}
		if (!options.open()) return;
		if (!hoverable() || event === undefined) {
			scheduleClose();
			return;
		}

		const triggerEl = options.trigger();
		const popupEl = options.popup();
		if (triggerEl == null || popupEl == null) {
			scheduleClose();
			return;
		}

		const inside = bridge_between(
			triggerEl.getBoundingClientRect(),
			popupEl.getBoundingClientRect()
		);
		if (!inside(event.clientX, event.clientY)) {
			scheduleClose();
			return;
		}

		stopWatching();
		const doc = popupEl.ownerDocument;
		const onMove = (move: PointerEvent) => {
			if (!inside(move.clientX, move.clientY)) {
				stopWatching();
				scheduleClose();
			}
		};
		doc.addEventListener('pointermove', onMove, { passive: true });
		stopBridge = () => doc.removeEventListener('pointermove', onMove);
	}

	$effect(() => () => {
		clear();
		if (groupName !== null) {
			const g = groupOf(groupName);
			if (g.active === handle) g.active = null;
		}
	});

	return {
		enter,
		leave,
		clear,
		open_now: openNow,
		close_now: closeNow
	};
}
