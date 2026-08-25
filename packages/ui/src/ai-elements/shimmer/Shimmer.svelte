<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils';
	import { watch } from 'runed';

	export type ShimmerProps = HTMLAttributes<HTMLElement> & {
		children: Snippet;
		as?: keyof HTMLElementTagNameMap;
		duration?: number;
		spread?: number;
		content_length?: number;
	};

	let {
		children,
		as = 'p',
		class: className,
		duration = 2,
		spread = 2,
		content_length = 30,
		...rest
	}: ShimmerProps = $props();

	const pulseFloor = $derived(Math.max(0.5, 0.68 - Math.min(content_length * spread, 120) / 1000));
</script>

<svelte:element
	this={as}
	class={cn(
		'relative inline-block text-muted-foreground',
		'animate-shimmer motion-reduce:animate-none',
		className
	)}
	style="--shimmer-floor: {pulseFloor}; --shimmer-duration: {duration}s;"
	{...rest}
>
	{@render children()}
</svelte:element>

<style>
	@keyframes shimmer {
		0%,
		100% {
			opacity: var(--shimmer-floor, 0.58);
		}
		50% {
			opacity: 0.9;
		}
	}

	:global(.animate-shimmer) {
		animation: shimmer var(--shimmer-duration, 1.8s) ease-in-out infinite;
	}
</style>
