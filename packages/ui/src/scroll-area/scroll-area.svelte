<script lang="ts">
	import { cn } from '#lib/utils';
	import { ScrollArea as ScrollAreaPrimitive, type WithoutChild } from 'bits-ui';
	import Scrollbar from './scroll-area-scrollbar.svelte';

	let {
		viewportRef = $bindable(null),
		ref = $bindable(null),
		class: className,
		orientation = 'vertical',
		scrollbarXClasses = '',
		scrollbarYClasses = '',
		viewPortClasses = '',
		onscroll,
		children,
		...restProps
	}: WithoutChild<ScrollAreaPrimitive.RootProps> & {
		viewportRef?: HTMLElement | null;
		orientation?: 'vertical' | 'horizontal' | 'both' | undefined;
		scrollbarXClasses?: string | undefined;
		scrollbarYClasses?: string | undefined;
		viewPortClasses?: string | undefined;
	} = $props();
</script>

<ScrollAreaPrimitive.Root bind:ref {...restProps} class={cn('relative overflow-hidden', className)}>
	<ScrollAreaPrimitive.Viewport
		bind:ref={viewportRef}
		{onscroll}
		class={cn('h-full w-full rounded-[inherit]', viewPortClasses)}
	>
		{@render children?.()}
	</ScrollAreaPrimitive.Viewport>
	{#if orientation === 'vertical' || orientation === 'both'}
		<Scrollbar orientation="vertical" class={scrollbarYClasses} />
	{/if}
	{#if orientation === 'horizontal' || orientation === 'both'}
		<Scrollbar orientation="horizontal" class={scrollbarXClasses} />
	{/if}
	<ScrollAreaPrimitive.Corner />
</ScrollAreaPrimitive.Root>
