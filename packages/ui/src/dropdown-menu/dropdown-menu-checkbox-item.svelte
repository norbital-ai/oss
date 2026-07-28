<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { DropdownMenu as DropdownMenuPrimitive, type WithoutChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChild<DropdownMenuPrimitive.CheckboxItemProps> = $props();
</script>

<DropdownMenuPrimitive.CheckboxItem
	bind:ref
	bind:checked
	class={cn(
		'relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<span class="absolute left-2 flex size-3.5 items-center justify-center">
			{#if restProps.indeterminate}
				<Icon icon="lucide:minus" class="size-4" />
			{:else}
				<Icon icon="lucide:check" class={cn('size-4', !checked && 'text-transparent')} />
			{/if}
		</span>
		{@render childrenProp?.({ checked, indeterminate: restProps.indeterminate ?? false })}
	{/snippet}
</DropdownMenuPrimitive.CheckboxItem>
