<script lang="ts">
	import type { Side } from './index.js';

	/**
	 * Props interface for the Sheet Content Resize component
	 */
	interface SheetContentResizeProps {
		/** Reference to the sheet content element */
		ref: HTMLElement;
		/** The side from which the sheet appears */
		side: Side;
		/** Clamp resizing to the sheet container instead of the viewport. */
		contained?: boolean;
		/** Side sheets that become bottom sheets on narrow viewports. */
		mobileBottomSheet?: boolean;
		/** Callback when horizontal resizing is done */
		onResize: () => void;
		/** Live + final vertical height in px (drives --sheet-height). */
		onHeightChange?: (height: number) => void;
	}

	/**
	 * Sheet Content Resize Component
	 *
	 * A thin, pill-shaped resize handle that appears on the edge of the sheet
	 * for resizing functionality.
	 */
	let {
		ref,
		side,
		contained = false,
		mobileBottomSheet = false,
		onResize,
		onHeightChange
	}: SheetContentResizeProps = $props();

	let isResizingWidth = $state(false);
	let isResizingHeight = $state(false);
	let startX = $state(0);
	let startY = $state(0);
	let startWidth = $state(0);
	let startHeight = $state(0);
	let activePointerId = $state<number | null>(null);
	let activeHandleElement = $state<HTMLElement | null>(null);

	function containerWidth(): number {
		return contained ? (ref.parentElement?.clientWidth ?? window.innerWidth) : window.innerWidth;
	}

	function containerHeight(): number {
		return contained ? (ref.parentElement?.clientHeight ?? window.innerHeight) : window.innerHeight;
	}

	/**
	 * Reset transient resize state and restore document affordances.
	 */
	function cleanupResizeState(): void {
		const pointerId = activePointerId;
		isResizingWidth = false;
		isResizingHeight = false;
		activePointerId = null;
		if (pointerId !== null && activeHandleElement?.hasPointerCapture(pointerId)) {
			activeHandleElement.releasePointerCapture(pointerId);
		}
		activeHandleElement = null;
		document.body.style.cursor = '';
		document.body.style.userSelect = '';
	}

	/**
	 * Handle pointer down event to start horizontal resizing.
	 */
	function handleWidthPointerDown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		if (!(event.currentTarget instanceof HTMLElement)) return;
		event.preventDefault();
		isResizingWidth = true;
		activePointerId = event.pointerId;
		activeHandleElement = event.currentTarget;
		startX = event.clientX;
		startWidth = ref.offsetWidth;
		activeHandleElement.setPointerCapture(event.pointerId);
		document.body.style.cursor = 'ew-resize';
		document.body.style.userSelect = 'none';
	}

	/**
	 * Handle pointer down event to start vertical resizing.
	 */
	function handleHeightPointerDown(event: PointerEvent): void {
		if (event.button !== 0) {
			return;
		}
		if (!(event.currentTarget instanceof HTMLElement)) return;
		event.preventDefault();
		isResizingHeight = true;
		activePointerId = event.pointerId;
		activeHandleElement = event.currentTarget;
		startY = event.clientY;
		startHeight = ref.offsetHeight;
		activeHandleElement.setPointerCapture(event.pointerId);
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';
	}

	function resizeHeight(height: number): void {
		const minHeight = 200;
		const maxHeight = containerHeight() * 0.95;
		onHeightChange?.(Math.max(minHeight, Math.min(height, maxHeight)));
	}

	function handleHeightKeyDown(event: KeyboardEvent): void {
		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();

		if (event.key === 'Home') {
			resizeHeight(200);
			return;
		}
		if (event.key === 'End') {
			resizeHeight(containerHeight() * 0.95);
			return;
		}
		resizeHeight(ref.offsetHeight + (event.key === 'ArrowUp' ? 24 : -24));
	}

	/**
	 * Handle pointer move during resizing.
	 */
	function handlePointerMove(event: PointerEvent): void {
		if (activePointerId !== event.pointerId) return;
		event.preventDefault();

		if (isResizingWidth) {
			const deltaX = event.clientX - startX;
			let newWidth: number;

			if (side === 'right') {
				newWidth = startWidth - deltaX;
			} else {
				newWidth = startWidth + deltaX;
			}

			const minWidth = 300;
			const maxWidth = containerWidth() * 0.9;
			newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));
			ref.style.width = `${newWidth}px`;
			return;
		}

		if (isResizingHeight) {
			const deltaY = startY - event.clientY;
			// Mobile CSS uses `height: var(--sheet-height) !important` — mutate via callback, not style.height.
			resizeHeight(startHeight + deltaY);
		}
	}

	/**
	 * Stop resizing when the active pointer ends or is cancelled.
	 */
	function finishResize(event?: PointerEvent): void {
		if (!isResizingWidth && !isResizingHeight) {
			return;
		}
		if (event && activePointerId !== null && event.pointerId !== activePointerId) {
			return;
		}
		const wasResizingWidth = isResizingWidth;
		cleanupResizeState();
		if (wasResizingWidth) onResize();
	}

	function handleWindowBlur(): void {
		if (!isResizingWidth && !isResizingHeight) {
			return;
		}
		const wasResizingWidth = isResizingWidth;
		cleanupResizeState();
		if (wasResizingWidth) onResize();
	}

	/**
	 * Determine the position styles based on the side
	 */
	const widthHandlePositionStyles = $derived(
		side === 'right' ? 'left-0 -translate-x-1/2' : 'right-0 translate-x-1/2'
	);
</script>

<svelte:window onblur={handleWindowBlur} />

{#if mobileBottomSheet}
	<!-- Vertical resize handle for mobile bottom sheets -->
	<button
		type="button"
		class="absolute top-0 left-1/2 z-20 flex h-6 w-24 -translate-x-1/2 touch-none cursor-ns-resize items-center justify-center rounded-md border-0 bg-transparent p-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:hidden"
		aria-label="Resize panel height"
		onpointerdown={handleHeightPointerDown}
		onpointermove={handlePointerMove}
		onpointerup={finishResize}
		onpointercancel={finishResize}
		onlostpointercapture={() => finishResize()}
		onkeydown={handleHeightKeyDown}
	>
		<div
			class="h-1 w-10 rounded-full bg-border transition-colors duration-150 hover:bg-input active:bg-input {isResizingHeight
				? 'bg-input'
				: ''}"
		></div>
	</button>
{/if}

<!-- Horizontal resize handle for desktop side sheets -->
<div
	class="absolute top-1/2 hidden -translate-y-1/2 touch-none outline-none {widthHandlePositionStyles} z-10 md:block"
	role="separator"
	aria-orientation="vertical"
	aria-label="Resize panel"
	onpointerdown={handleWidthPointerDown}
	onpointermove={handlePointerMove}
	onpointerup={finishResize}
	onpointercancel={finishResize}
	onlostpointercapture={() => finishResize()}
>
	<!-- Hitbox - larger invisible area for easier clicking -->
	<div class="absolute inset-0 -m-2 cursor-ew-resize"></div>

	<!-- Visual handle - the thin pill -->
	<div
		class="h-12 w-1.5 rounded-full bg-border transition-colors duration-150
			   hover:bg-input active:bg-input
			   {isResizingWidth ? 'bg-input' : ''}"
	>
		<!-- Optional: Add subtle pattern/texture -->
		<div class="h-full w-full rounded-full bg-linear-to-b from-white/10 to-transparent"></div>
	</div>
</div>
