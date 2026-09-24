<script lang="ts">
	import { Imposter, Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import Icon from '@iconify/svelte';
	import { DropdownMenu as DropdownMenuPrimitive, type WithoutChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChild<DropdownMenuPrimitive.RadioItemProps> = $props();
</script>

<DropdownMenuPrimitive.RadioItem
	bind:ref
	class={cn(
		// repository-health:allow UI27 -- the alignment/gap of the same bits-ui menu item element (see UI6 above)
		// repository-health:allow UI6 -- bits-ui owns the menu item element; consumers compose its direct children (icon, label, `ml-auto` shortcut) and restyle their spacing through `class`, which a nested primitive would silently drop
		'relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked })}
		<!-- The glyph hangs in the item's reserved `pl-8` gutter; a 16px glyph centred in a 14px box. -->
		<Imposter as="span" placement="center-start" layer="under" class="size-3.5">
			<Inline as="span" gap="none" justify="center" fill>
				{#if checked}
					<Icon icon="lucide:circle" class="size-2 fill-current" />
				{/if}
			</Inline>
		</Imposter>
		{@render childrenProp?.({ checked })}
	{/snippet}
</DropdownMenuPrimitive.RadioItem>
