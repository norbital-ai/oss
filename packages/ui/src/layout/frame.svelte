<script lang="ts" module>
	import type { Snippet } from 'svelte';
	import type { LayoutAttributes, LayoutElement } from './layout.shared.js';

	export type FrameRatio = 'square' | 'portrait' | 'landscape' | 'widescreen';
	export interface FrameProps extends LayoutAttributes {
		as?: LayoutElement;
		ratio?: FrameRatio;
		children: Snippet;
	}
</script>

<script lang="ts">
	import { cn } from '#lib/utils';

	let {
		as = 'div',
		ratio = 'landscape',
		class: className,
		children,
		...restProps
	}: FrameProps = $props();
	const ratioClasses: Record<FrameRatio, string> = {
		square: 'aspect-square',
		portrait: 'aspect-[3/4]',
		landscape: 'aspect-[4/3]',
		widescreen: 'aspect-video'
	};
</script>

<svelte:element
	this={as}
	class={cn(className, 'min-w-0 overflow-clip [&>img]:size-full [&>img]:object-cover', ratioClasses[ratio])}
	data-layout="frame"
	{...restProps}
>
	{@render children()}
</svelte:element>
