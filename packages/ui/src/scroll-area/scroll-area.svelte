<script lang="ts">
	import { cn } from '#lib/utils';
	import { Bound, scrollAffordance } from '#lib/layout';
	import { ScrollArea as ScrollAreaPrimitive, type WithoutChild } from 'bits-ui';
	import Scrollbar from './scroll-area-scrollbar.svelte';

	let {
		viewportRef = $bindable(null),
		ref = $bindable(null),
		class: className,
		orientation = 'vertical',
		fade = true,
		scrollbarXClasses = '',
		scrollbarYClasses = '',
		viewPortClasses = '',
		onscroll,
		children,
		...restProps
	}: WithoutChild<ScrollAreaPrimitive.RootProps> & {
		viewportRef?: HTMLElement | null;
		orientation?: 'vertical' | 'horizontal' | 'both' | undefined;
		fade?: boolean;
		scrollbarXClasses?: string | undefined;
		scrollbarYClasses?: string | undefined;
		viewPortClasses?: string | undefined;
	} = $props();
</script>

<!--
	The root clips its native viewport so the custom scrollbars replace the native ones. Uncontained,
	so a scroll area in a shrink-to-fit popover still sizes to its content; its height is the caller's.
-->
<ScrollAreaPrimitive.Root
	bind:ref
	{...restProps}
	class={cn('group/scroll-area relative [container-type:normal]', className)}
>
	{#snippet child({ props })}
		<Bound size="auto" clip {...props}>
			<ScrollAreaPrimitive.Viewport
				bind:ref={viewportRef}
				{onscroll}
				class={cn('h-full w-full rounded-[inherit]', viewPortClasses)}
				{@attach scrollAffordance({ fade })}
			>
				{@render children?.()}
			</ScrollAreaPrimitive.Viewport>
			{#if orientation === 'vertical' || orientation === 'both'}
				<!-- repository-health:allow UI25 -- forwards the caller's scrollbar class prop unchanged: nothing is composed, and the rule exempts only a component's own `className` -->
				<Scrollbar orientation="vertical" class={scrollbarYClasses} />
			{/if}
			{#if orientation === 'horizontal' || orientation === 'both'}
				<!-- repository-health:allow UI25 -- forwards the caller's scrollbar class prop unchanged: nothing is composed, and the rule exempts only a component's own `className` -->
				<Scrollbar orientation="horizontal" class={scrollbarXClasses} />
			{/if}
			<ScrollAreaPrimitive.Corner />
		</Bound>
	{/snippet}
</ScrollAreaPrimitive.Root>
