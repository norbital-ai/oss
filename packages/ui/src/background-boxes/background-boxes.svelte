<script lang="ts">
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		rows = 20,
		cols = 20,
		...restProps
	}: HTMLAttributes<HTMLDivElement> & {
		ref?: HTMLDivElement | null;
		children?: Snippet;
		rows?: number;
		cols?: number;
	} = $props();

	let rowsArray = $derived(Array.from({ length: rows }));
	let colsArray = $derived(Array.from({ length: cols }));
</script>

<div bind:this={ref} class={cn('relative h-full w-full overflow-hidden', className)} {...restProps}>
	<!-- Background boxes grid -->
	<div class="absolute inset-0 z-0 flex flex-wrap">
		{#each rowsArray as _, i}
			{#each colsArray as _, j}
				{@const animDelay = ((i + j) * 50) % 2000}
				{@const animDuration = 2000 + ((i * j) % 1000)}
				<div
					class="box-cell mounted relative h-12 w-12 border-t border-r border-neutral-300/60 transition-all duration-200 last:border-b hover:bg-brand-500/30 md:h-16 md:w-16 dark:border-neutral-700/60 dark:hover:bg-brand-400/20"
					class:border-l={j === 0}
					style="
					--animation-delay: {animDelay}ms;
					--animation-duration: {animDuration}ms;
				"
				></div>
			{/each}
		{/each}
	</div>

	<!-- Content overlay -->
	<div class="pointer-events-auto relative z-10">
		{@render children?.()}
	</div>
</div>

<style>
	@keyframes pulse-box {
		0%,
		100% {
			background-color: transparent;
			opacity: 1;
		}
		50% {
			background-color: rgba(59, 130, 246, 0.15);
			opacity: 1;
		}
	}

	.box-cell.mounted {
		animation: pulse-box var(--animation-duration, 2500ms) ease-in-out var(--animation-delay, 0ms)
			infinite;
	}

	.box-cell:hover {
		animation-play-state: paused;
		background-color: rgba(59, 130, 246, 0.25) !important;
	}
</style>
