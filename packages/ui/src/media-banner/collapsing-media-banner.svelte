<!-- fallow-ignore-file unrendered-component -- exported package banner rendered by the pod shell -->
<script lang="ts">
	import type { Attachment } from 'svelte/attachments';
	import { cn } from '#lib/utils';

	let {
		src,
		maxHeightPx = 112,
		minHeightPx = 0,
		scrollRoot = null,
		class: className
	}: {
		src: string;
		maxHeightPx?: number;
		minHeightPx?: number;
		scrollRoot?: HTMLElement | null;
		class?: string;
	} = $props();

	let failedSrc = $state<string | null>(null);
	let loadedSrc = $state<string | null>(null);
	let scrollTop = $state(0);

	const visible = $derived(src !== failedSrc);
	const loaded = $derived(src === loadedSrc);
	const heightPx = $derived(
		loaded ? Math.max(minHeightPx, maxHeightPx - scrollTop) : 0
	);

	/**
	 * Capture-phase scroll on `scrollRoot` (and its descendants) drives collapse.
	 * Passing `src` makes the attachment rebind (and reset scroll) when the banner changes.
	 */
	function captureScrollTop(
		root: HTMLElement | null,
		_bannerSrc: string
	): Attachment<HTMLElement> | undefined {
		if (!root) return undefined;
		return () => {
			scrollTop = 0;
			function handleScroll(event: Event): void {
				const target = event.target;
				if (!(target instanceof HTMLElement)) return;
				scrollTop = target.scrollTop;
			}
			root.addEventListener('scroll', handleScroll, { capture: true, passive: true });
			return () => {
				root.removeEventListener('scroll', handleScroll, { capture: true });
			};
		};
	}
</script>

{#if visible}
	<!-- Height is scroll-driven, so Frame's aspect ratio cannot own this crop. -->
	<div
		class={cn('relative overflow-clip', !loaded && 'invisible', className)}
		style:height="{heightPx}px"
		aria-hidden="true"
		{@attach captureScrollTop(scrollRoot, src)}
	>
		<img
			{src}
			alt=""
			class="size-full object-cover"
			onload={() => (loadedSrc = src)}
			onerror={() => (failedSrc = src)}
		/>
	</div>
{/if}
