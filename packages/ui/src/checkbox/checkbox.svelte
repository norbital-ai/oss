<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { Checkbox as CheckboxPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		...restProps
	}: WithoutChildrenOrChild<CheckboxPrimitive.RootProps> = $props();
</script>

<CheckboxPrimitive.Root
	bind:ref
	class={cn(
		'peer box-content size-4 shrink-0 rounded-sm border border-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset disabled:cursor-not-allowed disabled:opacity-50 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
		className
	)}
	bind:indeterminate
	bind:checked
	{...restProps}
>
	{#snippet children({ checked })}
		<div class="flex size-4 items-center justify-center text-current">
			{#if indeterminate}
				<Icon icon="lucide:minus" class="size-3.5" />
			{:else}
				<Icon icon="lucide:check" class={cn('size-3.5', !checked && 'text-transparent')} />
			{/if}
		</div>
	{/snippet}
</CheckboxPrimitive.Root>
