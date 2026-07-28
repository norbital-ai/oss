<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { RadioGroup as RadioGroupPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<RadioGroupPrimitive.ItemProps> = $props();
</script>

<RadioGroupPrimitive.Item
	bind:ref
	class={cn(
		'aspect-square size-4 rounded-full border border-primary text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<div class="flex items-center justify-center">
			{#if checked}
				<Icon icon="lucide:circle" class="size-2.5" color="var(--color-primary)" />
			{/if}
		</div>
	{/snippet}
</RadioGroupPrimitive.Item>
