<script lang="ts">
	import { cn } from '#lib/utils';
	import { ScrollArea as ScrollAreaPrimitive, type WithoutChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		orientation = 'vertical',
		children,
		...restProps
	}: WithoutChild<ScrollAreaPrimitive.ScrollbarProps> = $props();
</script>

<ScrollAreaPrimitive.Scrollbar
	bind:ref
	{orientation}
	class={cn(
		'flex touch-none transition-colors select-none',
		orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
		orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<ScrollAreaPrimitive.Thumb
		class={cn('relative rounded-full bg-border', orientation === 'vertical' && 'flex-1')}
	/>
</ScrollAreaPrimitive.Scrollbar>
