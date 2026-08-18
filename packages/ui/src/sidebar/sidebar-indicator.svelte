<script lang="ts">
	import type { WithElementRef } from '#lib/utils';
	import { cn } from '#lib/utils';
	import { SLIDING_INDICATOR_MS } from '#lib/sliding-indicator';
	import { onMount } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	const ACTIVE_SELECTOR =
		'[data-sidebar="menu-button"][data-active="true"], [data-sidebar="menu-sub-button"][data-active="true"]';

	/** Match shared sliding indicator duration on the rail element. */
	const ANIMATION_MS = SLIDING_INDICATOR_MS;

	let {
		ref = $bindable(null),
		class: className,
		position = 'left',
		width = 'w-[3px]',
		offset = 6,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> & {
		position?: 'left' | 'right';
		width?: string;
		offset?: number;
	} = $props();

	type IndicatorRect = {
		top: number;
		height: number;
		left: number;
	};

	let sidebarRootElement: HTMLElement | null = null;
	let menuContentElement: HTMLElement | null = null;
	let style = $state('opacity: 0;');
	let hasPositioned = false;
	let isAnimating = false;
	let pendingResizeSync = false;
	let trackFrameId = 0;
	let scheduleFrameId = 0;
	let animateEndTimer: ReturnType<typeof setTimeout> | undefined;
	let resizeFrameId = 0;

	function isElementVisible(el: HTMLElement): boolean {
		if (el.offsetHeight === 0 && el.offsetWidth === 0) return false;

		let current = el.parentElement;
		let insideContent = false;

		while (current && current !== sidebarRootElement) {
			if (
				current.getAttribute('data-sidebar') === 'menu-sub' ||
				current.hasAttribute('data-collapsible-content')
			) {
				insideContent = true;
			}
			if (
				current.getAttribute('data-state') === 'closed' &&
				current.hasAttribute('data-collapsible-root')
			) {
				if (insideContent) return false;
			}
			current = current.parentElement;
		}
		return true;
	}

	function findActiveElement(): HTMLElement | null {
		if (!sidebarRootElement) return null;

		const activeElements = Array.from(
			sidebarRootElement.querySelectorAll<HTMLElement>(ACTIVE_SELECTOR)
		);

		if (activeElements.length === 0) return null;

		for (let i = activeElements.length - 1; i >= 0; i--) {
			if (isElementVisible(activeElements[i])) {
				return activeElements[i];
			}
		}

		return null;
	}

	/** Places the rail on the active row — nested items are indented, so a fixed sidebar offset misses them. */
	function calculateIndicatorRect(el: HTMLElement): IndicatorRect | null {
		if (!ref || !el) return null;

		const containerRect = ref.getBoundingClientRect();
		const elRect = el.getBoundingClientRect();

		if (elRect.height === 0) return null;

		const indicatorHeight = elRect.height / 2;
		const center = elRect.top - containerRect.top + elRect.height / 2;
		const top = center - indicatorHeight / 2;
		const left =
			position === 'left' ? Math.max(0, elRect.left - containerRect.left + offset) : 0;

		return { top, height: indicatorHeight, left };
	}

	function clearAnimationTimer(): void {
		if (animateEndTimer !== undefined) {
			clearTimeout(animateEndTimer);
			animateEndTimer = undefined;
		}
	}

	function finishAnimation(): void {
		clearAnimationTimer();
		isAnimating = false;
		if (pendingResizeSync) {
			pendingResizeSync = false;
			updatePosition(true);
		}
	}

	function beginAnimation(): void {
		clearAnimationTimer();
		isAnimating = true;
		animateEndTimer = setTimeout(finishAnimation, ANIMATION_MS + 32);
	}

	function updatePosition(animate: boolean): void {
		if (!sidebarRootElement) return;

		const activeEl = findActiveElement();
		if (!activeEl) {
			style = 'opacity: 0;';
			return;
		}

		const rect = calculateIndicatorRect(activeEl);
		if (!rect) {
			style = 'opacity: 0;';
			return;
		}

		if (!hasPositioned) {
			animate = false;
			hasPositioned = true;
		}

		if (animate) {
			beginAnimation();
		}

		const transition = animate || isAnimating ? '' : ' transition: none;';
		style = `transform: translate3d(${rect.left}px, ${rect.top}px, 0); height: ${rect.height}px; opacity: 1;${transition}`;
	}

	function scheduleUpdate(animate: boolean): void {
		if (scheduleFrameId) cancelAnimationFrame(scheduleFrameId);
		scheduleFrameId = requestAnimationFrame(() => {
			scheduleFrameId = 0;
			updatePosition(animate);
		});
	}

	/** Let nav paint before starting the rail transition. */
	function scheduleAnimatedUpdate(): void {
		if (scheduleFrameId) cancelAnimationFrame(scheduleFrameId);
		beginAnimation();
		scheduleFrameId = requestAnimationFrame(() => {
			scheduleFrameId = requestAnimationFrame(() => {
				scheduleFrameId = 0;
				updatePosition(true);
			});
		});
	}

	function scheduleResizeSync(): void {
		if (isAnimating) {
			pendingResizeSync = true;
			return;
		}
		if (resizeFrameId) cancelAnimationFrame(resizeFrameId);
		resizeFrameId = requestAnimationFrame(() => {
			resizeFrameId = 0;
			updatePosition(false);
		});
	}

	function startTracking(): void {
		if (trackFrameId) cancelAnimationFrame(trackFrameId);
		const startTime = performance.now();

		function loop(): void {
			updatePosition(false);
			if (performance.now() - startTime < 500) {
				trackFrameId = requestAnimationFrame(loop);
			} else {
				trackFrameId = 0;
				updatePosition(true);
			}
		}
		loop();
	}

	onMount(() => {
		if (!ref) return;

		let current = ref.parentElement;
		while (current) {
			if (current.getAttribute('data-sidebar') === 'sidebar') {
				sidebarRootElement = current;
				menuContentElement =
					current.querySelector<HTMLElement>('[data-sidebar="content"]') ?? current;
				break;
			}
			current = current.parentElement;
		}

		if (!sidebarRootElement || !menuContentElement) return;

		updatePosition(false);

		const mo = new MutationObserver((mutations) => {
			let shouldTrack = false;
			let shouldAnimate = false;

			for (const m of mutations) {
				if (m.type === 'childList') {
					shouldAnimate = true;
				} else if (m.attributeName === 'data-state') {
					shouldTrack = true;
				} else if (m.attributeName === 'data-active') {
					shouldAnimate = true;
				}
			}

			if (shouldTrack) {
				scheduleUpdate(false);
				startTracking();
			} else if (shouldAnimate) {
				scheduleAnimatedUpdate();
			}
		});

		mo.observe(sidebarRootElement, {
			attributes: true,
			childList: true,
			subtree: true,
			attributeFilter: ['data-active', 'data-state']
		});

		const ro = new ResizeObserver(() => {
			scheduleResizeSync();
		});
		ro.observe(menuContentElement);

		return () => {
			mo.disconnect();
			ro.disconnect();
			clearAnimationTimer();
			if (trackFrameId) cancelAnimationFrame(trackFrameId);
			if (scheduleFrameId) cancelAnimationFrame(scheduleFrameId);
			if (resizeFrameId) cancelAnimationFrame(resizeFrameId);
		};
	});

	const positionStyle = $derived(position === 'left' ? 'left: 0;' : `right: ${offset}px;`);
</script>

<div
	bind:this={ref}
	class={cn('pointer-events-none absolute inset-y-0 z-30', className)}
	style={positionStyle}
	{...restProps}
>
	<div
		class={cn(
			'absolute left-0 top-0 rounded-lg bg-brand transition-[transform,height] duration-200 ease-[cubic-bezier(0.4,0,0.2,1)] will-change-transform',
			width
		)}
		{style}
	></div>
</div>
