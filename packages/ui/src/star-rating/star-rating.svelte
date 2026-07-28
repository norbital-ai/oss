<!-- star-rating.svelte -->
<script lang="ts">
	import { cn } from '#lib/utils';
	import { RatingGroup } from 'bits-ui';
	import type { StarRatingRootProps } from './types.js';

	let {
		value = $bindable(0),
		max = 5,
		min = 0,
		disabled = false,
		readonly = false,
		required = false,
		allowHalf = false,
		hoverPreview = true,
		orientation = 'horizontal',
		name,
		class: className,
		onValueChange,
		children,
		...rest
	}: StarRatingRootProps = $props();

	// Handle value changes
	function handleValueChange(newValue: number) {
		value = newValue;
		onValueChange?.(newValue);
	}
</script>

<RatingGroup.Root
	bind:value
	onValueChange={handleValueChange}
	{max}
	{min}
	{disabled}
	{readonly}
	{required}
	{allowHalf}
	{hoverPreview}
	{orientation}
	{name}
	class={cn(
		'group flex w-fit place-items-center gap-1 rounded-md outline-hidden',
		orientation === 'vertical' && 'flex-col',
		className
	)}
	{...rest}
>
	{#snippet children({ items, value: currentValue, max: maxValue })}
		{@render children?.({ items, value: currentValue, max: maxValue })}
	{/snippet}
</RatingGroup.Root>
