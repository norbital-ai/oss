<script lang="ts">
	import { cn } from '#lib/utils';
	import { DropdownMenu as DropdownMenuPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		inset,
		...restProps
	}: DropdownMenuPrimitive.ItemProps & {
		inset?: boolean;
	} = $props();
</script>

<DropdownMenuPrimitive.Item
	bind:ref
	class={cn(
		// repository-health:allow UI27 -- the alignment/gap of the same bits-ui menu item element (see UI6 above)
		// repository-health:allow UI6 -- bits-ui owns the menu item element; consumers compose its direct children (icon, label, `ml-auto` shortcut) and restyle their spacing through `class`, which a nested primitive would silently drop
		'relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
		inset && 'pl-8',
		className
	)}
	{...restProps}
/>
