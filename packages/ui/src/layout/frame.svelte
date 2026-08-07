<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from './layout.shared.js';

	/** Named media crops. `banner` is the compact overview / sheet hero (2:1). */
	export type FrameRatio = 'square' | 'portrait' | 'landscape' | 'widescreen' | 'banner';
	export interface FrameProps extends LayoutAttributes {
		as?: LayoutElement;
		ratio?: FrameRatio;
		/** Allow this region to shrink when its parent is constrained. */
		shrink?: boolean;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';

	let {
		as = 'div',
		ratio = 'landscape',
		shrink = true,
		class: className,
		children,
		...restProps
	}: FrameProps = $props();
	const ratioClasses: Record<FrameRatio, string> = {
		square: 'aspect-square',
		portrait: 'aspect-[3/4]',
		landscape: 'aspect-[4/3]',
		widescreen: 'aspect-video',
		banner: 'aspect-[2/1]'
	};
</script>

<svelte:element
	this={as}
	class={cn(
		className,
		'min-w-0 overflow-clip [&>img]:size-full [&>img]:object-cover',
		ratioClasses[ratio],
		!shrink && 'shrink-0'
	)}
	data-layout="frame"
	{...restProps}
>
	{@render children()}
</svelte:element>
