<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { ContextMenu as ContextMenuPrimitive, type WithoutChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		inset,
		children,
		...restProps
	}: WithoutChild<ContextMenuPrimitive.SubTriggerProps> & {
		inset?: boolean;
	} = $props();
</script>

<ContextMenuPrimitive.SubTrigger
	bind:ref
	class={cn(
		'flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
		inset && 'pl-8',
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<Icon icon="lucide:chevron-right" class="ml-auto size-4" />
</ContextMenuPrimitive.SubTrigger>
