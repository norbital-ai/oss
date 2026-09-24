<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from '#lib/layout/layout.shared';

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
		ref = $bindable(null),
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
	bind:this={ref}
	class={cn(
		'flex min-w-0 items-center justify-center overflow-clip [&>img]:size-full [&>img]:object-cover [&>video]:size-full [&>video]:object-cover',
		ratioClasses[ratio],
		!shrink && 'shrink-0',
		// The caller's class last: floors, layers and colours it names win; layout itself is props (doctor-enforced).
		className
	)}
	data-layout="frame"
	{...restProps}
>
	{@render children()}
</svelte:element>
