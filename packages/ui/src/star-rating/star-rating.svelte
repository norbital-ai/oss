<!-- star-rating.svelte -->
<script lang="ts">
	import { Inline, Stack } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { RatingGroup } from 'bits-ui';
	import type { StarRatingRootProps } from '#lib/star-rating/types';

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
	class={cn('group w-fit rounded-md outline-hidden', className)}
	{...rest}
>
	{#snippet child({ props, items, value: currentValue, max: maxValue })}
		{#if orientation === 'vertical'}
			<Stack gap="xs" align="center" {...props}>
				{@render children?.({ items, value: currentValue, max: maxValue })}
			</Stack>
		{:else}
			<Inline gap="xs" {...props}>
				{@render children?.({ items, value: currentValue, max: maxValue })}
			</Inline>
		{/if}
	{/snippet}
</RatingGroup.Root>
