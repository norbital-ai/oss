<script lang="ts">
	import { cn } from '#lib/utils';
	import { Imposter } from '#lib/layout';
	import { useResizeObserver, watch } from 'runed';
	import type { Snippet } from 'svelte';
	import { computeDocTocTrackBounds } from '#lib/doc-toc/anchor-observer';
	import { getDocTocState } from './context.svelte';
	import { measureDocTocItemPositions, type DocTocPosition } from '#lib/doc-toc/measure-positions';

	let {
		class: className,
		children
	}: {
		class?: string;
		children: Snippet;
	} = $props();

	const toc = getDocTocState()();

	/**
	 * Bound rather than written inline on the element. A `style:` directive's value is parsed as one
	 * token, and this string is long enough that Prettier wraps it — which splits the directive
	 * across lines and stops the component compiling. Keeping it here is also the only way the
	 * formatter and the compiler can both be satisfied without an ignore comment.
	 */
	const TRACK_CLIP_PATH =
		'polygon(0 var(--track-top, 0), 100% var(--track-top, 0), 100% var(--track-bottom, 0), 0 var(--track-bottom, 0))';

	let containerElement = $state<HTMLDivElement | null>(null);
	let positions = $state<DocTocPosition[]>([]);

	function measure(): void {
		positions = containerElement ? measureDocTocItemPositions(containerElement, toc.items) : [];
	}

	const trackBounds = $derived(computeDocTocTrackBounds(positions, toc.observedItems));

	watch(
		() => [toc.items, containerElement] as const,
		() => measure()
	);

	useResizeObserver(
		() => containerElement,
		() => measure()
	);
</script>

<div class="relative min-h-0">
	{#if trackBounds}
		<Imposter
			placement="start"
			layer="under"
			class="pointer-events-none inset-s-0 w-px bg-primary transition-[clip-path] duration-150 ease-out"
			style="--track-top: {trackBounds.top}px; --track-bottom: {trackBounds.bottom}px; clip-path: {TRACK_CLIP_PATH}"
			aria-hidden="true"
		/>
	{/if}
	<div bind:this={containerElement} class={cn('relative border-s border-foreground/10', className)}>
		{@render children()}
	</div>
</div>
