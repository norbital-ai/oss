<script lang="ts">
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		inset,
		children,
		...restProps
	}: DropdownMenuPrimitive.SubTriggerProps & {
		inset?: boolean;
	} = $props();
</script>

<DropdownMenuPrimitive.SubTrigger
	bind:ref
	class={cn(
		// repository-health:allow UI27 -- the alignment/gap of the same bits-ui menu item element (see UI6 above)
		// repository-health:allow UI6 -- bits-ui owns the menu item element; consumers compose its direct children (icon, label, `ml-auto` shortcut) and restyle their spacing through `class`, which a nested primitive would silently drop
		'flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground',
		inset && 'pl-8',
		className
	)}
	{...restProps}
>
	{@render children?.()}
	<Icon icon="lucide:chevron-right" class="ml-auto size-4" />
</DropdownMenuPrimitive.SubTrigger>
