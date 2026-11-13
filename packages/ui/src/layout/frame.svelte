<!--
@component
Crops media to a named aspect ratio (`square`, `portrait`, `landscape`, `widescreen`, `banner`). A crop is its own size: never squeezed.
-->
<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from './layout.shared.js';

	/** Named media crops. `banner` is the compact overview / sheet hero (2:1). */
	type FrameRatio = 'square' | 'portrait' | 'landscape' | 'widescreen' | 'banner';
	/** The props of `Frame`. */
	interface FrameProps extends LayoutAttributes {
		/** The element rendered; `div` by default. */
		as?: LayoutElement;
		/** The crop: `square` 1:1, `portrait` 3:4, `landscape` 4:3 (default), `widescreen` 16:9, `banner` 2:1. */
		ratio?: FrameRatio;
		/** The media, centred; a direct `img` or `video` covers the frame. */
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '../primitives/utils.js';

	let {
		as = 'div',
		ref = $bindable(null),
		ratio = 'landscape',
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
	bind:this={ref}
	class={cn(
		'flex min-w-0 flex-none items-center justify-center overflow-clip [&>img]:size-full [&>img]:object-cover [&>video]:size-full [&>video]:object-cover',
		ratioClasses[ratio],
		// The caller's class last: floors, layers and colours it names win; layout itself is props.
		className
	)}
	data-layout="frame"
	{...restProps}
>
	{@render children()}
</svelte:element>
