<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { ContextMenu as ContextMenuPrimitive, type WithoutChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChild<ContextMenuPrimitive.RadioItemProps> = $props();
</script>

<ContextMenuPrimitive.RadioItem
	bind:ref
	class={cn(
		'relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<span class="absolute left-2 flex size-3.5 items-center justify-center">
			{#if checked}
				<Icon icon="lucide:circle" class="size-2 fill-current" />
			{/if}
		</span>
		{@render childrenProp?.({ checked })}
	{/snippet}
</ContextMenuPrimitive.RadioItem>
