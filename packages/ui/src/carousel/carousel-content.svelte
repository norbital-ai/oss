<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils';
	import emblaCarouselSvelte from 'embla-carousel-svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { getEmblaContext } from '#lib/carousel/context';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();

	const emblaCtx = getEmblaContext('<Carousel.Content/>')();
</script>

<!-- stupidity:allow UI5 -- carousel viewport crop -->
<div
	data-slot="carousel-content"
	class="overflow-hidden"
	use:emblaCarouselSvelte={{
		options: {
			container: '[data-embla-container]',
			slides: '[data-embla-slide]',
			...emblaCtx.options,
			axis: emblaCtx.orientation === 'horizontal' ? 'x' : 'y'
		},
		plugins: emblaCtx.plugins
	}}
	onemblaInit={emblaCtx.onInit}
>
	<!-- stupidity:allow UI7 -- this leaf component owns responsive or internal spacing as part of its public DOM contract -->
	<div
		bind:this={ref}
		class={cn(
			'flex',
			emblaCtx.orientation === 'horizontal' ? '-ml-4' : '-mt-4 flex-col',
			className
		)}
		data-embla-container=""
		{...restProps}
	>
		{@render children?.()}
	</div>
</div>
