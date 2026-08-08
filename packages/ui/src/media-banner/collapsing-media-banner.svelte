<!-- fallow-ignore-file unrendered-component -- exported package banner rendered by the pod shell -->
<script lang="ts">
	import type { Action } from 'svelte/action';
	import { fromAction } from 'svelte/attachments';
	import { IconWrapper } from '#lib/icon-wrapper';
	import { INSET_X_CLASS } from '#lib/layout';
	import { cn } from '#lib/utils';

	let {
		src,
		icon = null,
		maxHeightPx = 96,
		minHeightPx = 0,
		scrollRoot = null,
		class: className
	}: {
		src: string;
		/** Iconify / product icon name from app manifest (`pod:icon`). Shown overlapping bottom-left when present. */
		icon?: string | null;
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
	const heightPx = $derived(loaded ? Math.max(minHeightPx, maxHeightPx - scrollTop) : 0);
	const iconOverlapPx = $derived(Math.min(28, heightPx));

	/**
	 * Capture-phase scroll on `scrollRoot` (and its descendants) drives collapse.
	 * `fromAction` rebinds when `scrollRoot` or `src` changes — including the common
	 * first-paint case where Cover mounts the banner before `appSurfaceEl` is bound.
	 */
	const captureScroll: Action<HTMLElement, { root: HTMLElement | null; src: string }> = (
		_node,
		param
	) => {
		let root: HTMLElement | null = null;

		function handleScroll(event: Event): void {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			scrollTop = target.scrollTop;
		}

		function unbind(): void {
			if (!root) return;
			root.removeEventListener('scroll', handleScroll, { capture: true });
			root = null;
		}

		function bind(next: { root: HTMLElement | null; src: string }): void {
			unbind();
			scrollTop = 0;
			if (!next.root) return;
			root = next.root;
			root.addEventListener('scroll', handleScroll, { capture: true, passive: true });
		}

		bind(param);
		return {
			update: bind,
			destroy: unbind
		};
	};
</script>

{#if visible}
	<div
		class={cn('relative', className)}
		{@attach fromAction(captureScroll, () => ({ root: scrollRoot, src }))}
	>
		<!-- Height is scroll-driven, so Frame's aspect ratio cannot own this crop. -->
		<div
			class={cn('overflow-clip', !loaded && 'invisible')}
			style:height="{heightPx}px"
			aria-hidden="true"
		>
			<img
				{src}
				alt=""
				class="block size-full max-h-full object-cover"
				onload={() => (loadedSrc = src)}
				onerror={() => (failedSrc = src)}
			/>
		</div>
		{#if icon && loaded}
			<div class={INSET_X_CLASS} style:margin-top="-{iconOverlapPx}px" aria-hidden="true">
				<div
					class="flex size-14 items-center justify-center rounded-xl border border-input bg-background text-foreground shadow-xs"
				>
					<IconWrapper name={icon} class="size-7" />
				</div>
			</div>
		{/if}
	</div>
{/if}
