<script lang="ts">
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import { onMount } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		delay = 0,
		duration = 0.5,
		yOffset = 8,
		blur = '10px',
		inView = false,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		ref?: HTMLDivElement | null;
		children?: Snippet;
		delay?: number;
		duration?: number;
		yOffset?: number;
		blur?: string;
		inView?: boolean;
	} = $props();

	let mounted = $state(false);
	let isInView = $state(false);
	const inViewMode = $derived(inView);

	// stupidity:allow V11 -- mounted intentionally starts the entrance transition after hydration
	onMount(() => {
		// Small delay to ensure DOM is ready
		const timer = setTimeout(() => {
			mounted = true;
		}, 50);

		// If inView mode is enabled, use Intersection Observer
		if (inViewMode && ref) {
			const observer = new IntersectionObserver(
				(entries) => {
					entries.forEach((entry) => {
						if (entry.isIntersecting) {
							isInView = true;
							observer.disconnect();
						}
					});
				},
				{ threshold: 0.1 }
			);

			if (ref) observer.observe(ref);

			return () => {
				clearTimeout(timer);
				observer.disconnect();
			};
		}

		return () => clearTimeout(timer);
	});

	const shouldAnimate = $derived(inViewMode ? isInView : mounted);
</script>

<div
	bind:this={ref}
	class={cn('blur-fade-wrapper', className)}
	class:animate={shouldAnimate}
	style="--delay: {delay}s; --duration: {duration}s; --y-offset: {yOffset}px; --blur: {blur};"
	{...restProps}
>
	{@render children?.()}
</div>

<style>
	.blur-fade-wrapper {
		opacity: 0;
		transform: translateY(var(--y-offset));
		filter: blur(var(--blur));
		transition:
			opacity var(--duration) cubic-bezier(0.16, 1, 0.3, 1) var(--delay),
			transform var(--duration) cubic-bezier(0.16, 1, 0.3, 1) var(--delay),
			filter var(--duration) cubic-bezier(0.16, 1, 0.3, 1) var(--delay);
		will-change: opacity, transform, filter;
	}

	.blur-fade-wrapper.animate {
		opacity: 1;
		transform: translateY(0);
		filter: blur(0);
	}

	@media (prefers-reduced-motion: reduce) {
		.blur-fade-wrapper {
			transition: none;
			opacity: 1;
			transform: none;
			filter: none;
		}
	}
</style>
