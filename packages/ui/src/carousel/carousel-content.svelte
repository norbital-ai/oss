<script lang="ts">
	import { Bound, Inline, Stack } from '#lib/layout';
	import { fromAction } from 'svelte/attachments';
	import { on } from 'svelte/events';
	import { cn, type WithElementRef } from '#lib/utils';
	import emblaCarouselSvelte from 'embla-carousel-svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { getEmblaContext, type CarouselAPI } from '#lib/carousel/context';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLDivElement>> = $props();

	const emblaCtx = getEmblaContext('<Carousel.Content/>')();
	const Track = $derived(emblaCtx.orientation === 'horizontal' ? Inline : Stack);
</script>

<!-- embla's viewport: it clips the translated slide track. -->
<Bound
	size="auto"
	clip
	data-slot="carousel-content"
	{@attach (node: HTMLElement) =>
		on(node, 'emblaInit', (event) => emblaCtx.onInit(event as CustomEvent<CarouselAPI>))}
	{@attach fromAction(emblaCarouselSvelte, () => ({
		options: {
			container: '[data-embla-container]',
			slides: '[data-embla-slide]',
			...emblaCtx.options,
			axis: emblaCtx.orientation === 'horizontal' ? ('x' as const) : ('y' as const)
		},
		plugins: emblaCtx.plugins
	}))}
>
	<Track
		gap="none"
		align="stretch"
		class={cn(emblaCtx.orientation === 'horizontal' ? '-ml-4' : '-mt-4', className)}
		data-embla-container=""
		{...restProps}
		{@attach (node: HTMLDivElement) => {
			ref = node;
			return () => (ref = null);
		}}
	>
		{@render children?.()}
	</Track>
</Bound>
