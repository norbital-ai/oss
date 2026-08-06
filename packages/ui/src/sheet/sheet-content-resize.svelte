<script lang="ts">
	import { useI18n, type UiKeys } from '#lib/i18n';
	import type { Side } from './index.js';

	const { t } = useI18n<UiKeys>();

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
		/** Final vertical height in px, emitted after a drag or keyboard resize. */
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

	let resizing = $state<'width' | 'height' | null>(null);
	let startX = 0;
	let startY = 0;
	let startWidth = 0;
	let startHeight = 0;
	let activePointerId: number | null = null;
	let activeHandleElement: HTMLElement | null = null;
	let maxDragHeight = 0;
	let liveHeight: number | null = null;

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
		resizing = null;
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
		resizing = 'width';
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
		resizing = 'height';
		activePointerId = event.pointerId;
		activeHandleElement = event.currentTarget;
		startY = event.clientY;
		startHeight = ref.offsetHeight;
		maxDragHeight = containerHeight() * 0.95;
		liveHeight = startHeight;
		activeHandleElement.setPointerCapture(event.pointerId);
		document.body.style.cursor = 'ns-resize';
		document.body.style.userSelect = 'none';
	}

	function clampHeight(height: number, maxHeight = containerHeight() * 0.95): number {
		const minHeight = 200;
		return Math.max(minHeight, Math.min(height, maxHeight));
	}

	function renderHeight(height: number, maxHeight = containerHeight() * 0.95): number {
		const nextHeight = clampHeight(height, maxHeight);
		// Keep the hot drag path outside Svelte reactivity and storage. Updating the
		// custom property lets the browser paint the sheet at pointer speed without
		// invalidating every child component.
		ref.style.setProperty('--sheet-height', `${nextHeight}px`);
		liveHeight = nextHeight;
		return nextHeight;
	}

	function commitHeight(height: number): void {
		onHeightChange?.(renderHeight(height));
	}

	function handleHeightKeyDown(event: KeyboardEvent): void {
		if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
		event.preventDefault();

		if (event.key === 'Home') {
			commitHeight(200);
			return;
		}
		if (event.key === 'End') {
			commitHeight(containerHeight() * 0.95);
			return;
		}
		commitHeight(ref.offsetHeight + (event.key === 'ArrowUp' ? 24 : -24));
	}

	/**
	 * Handle pointer move during resizing.
	 */
	function handlePointerMove(event: PointerEvent): void {
		if (activePointerId !== event.pointerId) return;
		event.preventDefault();

		if (resizing === 'width') {
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

		if (resizing === 'height') {
			const deltaY = startY - event.clientY;
			renderHeight(startHeight + deltaY, maxDragHeight);
		}
	}

	/**
	 * Stop resizing when the active pointer ends or is cancelled.
	 */
	function finishResize(event?: PointerEvent): void {
		if (!resizing) {
			return;
		}
		if (event && activePointerId !== null && event.pointerId !== activePointerId) {
			return;
		}
		const wasResizingWidth = resizing === 'width';
		const finalHeight = resizing === 'height' ? (liveHeight ?? ref.offsetHeight) : null;
		cleanupResizeState();
		if (wasResizingWidth) onResize();
		if (finalHeight !== null) onHeightChange?.(finalHeight);
		liveHeight = null;
	}

	function handleWindowBlur(): void {
		if (!resizing) {
			return;
		}
		const wasResizingWidth = resizing === 'width';
		const finalHeight = resizing === 'height' ? (liveHeight ?? ref.offsetHeight) : null;
		cleanupResizeState();
		if (wasResizingWidth) onResize();
		if (finalHeight !== null) onHeightChange?.(finalHeight);
		liveHeight = null;
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
		aria-label={t('misc.resizePanelHeight')}
		onpointerdown={handleHeightPointerDown}
		onpointermove={handlePointerMove}
		onpointerup={finishResize}
		onpointercancel={finishResize}
		onlostpointercapture={() => finishResize()}
		onkeydown={handleHeightKeyDown}
	>
		<div
			class="h-1 w-10 rounded-full bg-border transition-colors duration-150 hover:bg-input active:bg-input {resizing ===
			'height'
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
	aria-label={t('misc.resizePanel')}
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
			   {resizing === 'width' ? 'bg-input' : ''}"
	>
		<!-- Optional: Add subtle pattern/texture -->
		<div class="h-full w-full rounded-full bg-linear-to-b from-white/10 to-transparent"></div>
	</div>
</div>
