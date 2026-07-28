interface PixelDragState {
	pointerId: number;
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
	dx: number;
	dy: number;
}

interface PixelDragOptions {
	onStart?: (e: PointerEvent) => void;
	onMove?: (e: PointerEvent, dx: number, dy: number, startX: number, startY: number) => void;
	onEnd?: (e: PointerEvent) => void;
	onCancel?: () => void;
	axis?: 'x' | 'y' | 'both';
	throttleMs?: number;
	cursor?: string;
}

export function pixelDrag(node: HTMLElement, options: PixelDragOptions) {
	let state: PixelDragState | null = null;
	let throttlePending = false;
	let throttleTimer: ReturnType<typeof setTimeout> | null = null;

	function applyCursor() {
		if (options.cursor) {
			node.style.cursor = options.cursor;
		}
	}

	function constrain() {
		if (!state) return;
		const axis = options.axis ?? 'both';
		if (axis === 'x') state.dy = 0;
		if (axis === 'y') state.dx = 0;
	}

	function onPointerDown(e: PointerEvent) {
		state = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			currentX: e.clientX,
			currentY: e.clientY,
			dx: 0,
			dy: 0
		};
		node.setPointerCapture(e.pointerId);
		options.onStart?.(e);
	}

	function onPointerMove(e: PointerEvent) {
		if (!state || e.pointerId !== state.pointerId) return;
		const ms = options.throttleMs ?? 0;
		if (ms > 0) {
			if (throttlePending) return;
			throttlePending = true;
			throttleTimer = setTimeout(() => {
				throttlePending = false;
				throttleTimer = null;
			}, ms);
		}
		state.currentX = e.clientX;
		state.currentY = e.clientY;
		state.dx = state.currentX - state.startX;
		state.dy = state.currentY - state.startY;
		constrain();
		if (options.onMove) {
			options.onMove(e, state.dx, state.dy, state.startX, state.startY);
		}
	}

	function onPointerUp(e: PointerEvent) {
		if (!state || e.pointerId !== state.pointerId) return;
		options.onEnd?.(e);
		state = null;
	}

	function onCancel(e: Event) {
		if (!state) return;
		if (e instanceof PointerEvent && e.pointerId !== state.pointerId) return;
		options.onCancel?.();
		state = null;
	}

	function cleanup() {
		const pointerId = state?.pointerId;
		state = null;
		if (throttleTimer) {
			clearTimeout(throttleTimer);
			throttleTimer = null;
		}
		node.removeEventListener('pointerdown', onPointerDown);
		node.removeEventListener('pointermove', onPointerMove);
		node.removeEventListener('pointerup', onPointerUp);
		node.removeEventListener('pointercancel', onCancel);
		if (pointerId !== undefined) {
			node.releasePointerCapture(pointerId);
		}
		window.removeEventListener('blur', onCancel);
		if (options.cursor) {
			node.style.cursor = '';
		}
	}

	applyCursor();
	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerUp);
	node.addEventListener('pointercancel', onCancel);
	window.addEventListener('blur', onCancel);

	return {
		update(newOptions: PixelDragOptions) {
			options = newOptions;
			applyCursor();
		},
		destroy() {
			cleanup();
		}
	};
}
