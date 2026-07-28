<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import type { WithoutChildren } from 'bits-ui';
	import { Button, type Props } from '../button';
	import { getEmblaContext } from './context.js';

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

<Button
	data-slot={isNext ? 'carousel-next' : 'carousel-previous'}
	{variant}
	{size}
	class={cn(
		'absolute size-8 rounded-full',
		emblaCtx.orientation === 'horizontal'
			? isNext
				? 'top-1/2 -right-12 -translate-y-1/2'
				: 'top-1/2 -left-12 -translate-y-1/2'
			: isNext
				? '-bottom-12 left-1/2 -translate-x-1/2 rotate-90'
				: '-top-12 left-1/2 -translate-x-1/2 rotate-90',
		className
	)}
	disabled={isNext ? !emblaCtx.canScrollNext : !emblaCtx.canScrollPrev}
	onclick={isNext ? emblaCtx.scrollNext : emblaCtx.scrollPrev}
	onkeydown={emblaCtx.handleKeyDown}
	bind:ref
	{...restProps}
>
	<Icon icon={isNext ? 'lucide:arrow-right' : 'lucide:arrow-left'} class="size-4" />
	<span class="sr-only">{isNext ? 'Next slide' : 'Previous slide'}</span>
</Button>
