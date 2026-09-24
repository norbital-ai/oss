<script lang="ts">
	import { Imposter } from '#lib/layout';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import type { WithoutChildren } from 'bits-ui';
	import { Button, type Props } from '#lib/button';
	import { getEmblaContext } from '#lib/carousel/context';

	let {
		ref = $bindable(null),
		direction = 'next',
		class: className,
		variant = 'outline',
		size = 'icon',
		...restProps
	}: WithoutChildren<Props> & { direction?: 'next' | 'previous' } = $props();

	const isNext = $derived(direction === 'next');
	const emblaCtx = getEmblaContext('<Carousel.Button/>')();
</script>

<!-- The caller's class positions the control (a carousel inset pins it at `left-0!`), so it lands on the layer. -->
<Imposter
	placement={emblaCtx.orientation === 'horizontal'
		? isNext
			? 'center-end'
			: 'center-start'
		: isNext
			? 'bottom-start'
			: 'top-start'}
	class={cn(
		'leading-none',
		emblaCtx.orientation === 'horizontal'
			? isNext
				? '-right-12'
				: '-left-12'
			: isNext
				? '-bottom-12 left-1/2 -translate-x-1/2'
				: '-top-12 left-1/2 -translate-x-1/2',
		className
	)}
>
	<Button
		data-slot={isNext ? 'carousel-next' : 'carousel-previous'}
		{variant}
		{size}
		class={cn('size-8 rounded-full align-top', emblaCtx.orientation === 'vertical' && 'rotate-90')}
		disabled={isNext ? !emblaCtx.canScrollNext : !emblaCtx.canScrollPrev}
		onclick={isNext ? emblaCtx.scrollNext : emblaCtx.scrollPrev}
		onkeydown={emblaCtx.handleKeyDown}
		bind:ref
		{...restProps}
	>
		<Icon icon={isNext ? 'lucide:arrow-right' : 'lucide:arrow-left'} class="size-4" />
		<span class="sr-only">{isNext ? 'Next slide' : 'Previous slide'}</span>
	</Button>
</Imposter>
