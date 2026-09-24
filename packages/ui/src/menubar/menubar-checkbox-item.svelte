<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Menubar as MenubarPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

	import { Imposter, Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import type { Snippet } from 'svelte';

	let {
		ref = $bindable(null),
		class: className,
		checked = $bindable(false),
		indeterminate = $bindable(false),
		children: childrenProp,
		...restProps
	}: WithoutChildrenOrChild<MenubarPrimitive.CheckboxItemProps> & {
		children?: Snippet;
	} = $props();
</script>

<MenubarPrimitive.CheckboxItem
	bind:ref
	bind:checked
	bind:indeterminate
	class={cn(
		// repository-health:allow UI27 -- the alignment/gap of the same bits-ui menu item element (see UI6 above)
		// repository-health:allow UI6 -- bits-ui owns the menu item element; consumers compose its direct children (icon, label, `ml-auto` shortcut) and restyle their spacing through `class`, which a nested primitive would silently drop
		'relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked, indeterminate })}
		<!-- The glyph hangs in the item's reserved `pl-8` gutter; a 16px glyph centred in a 14px box. -->
		<Imposter as="span" placement="center-start" layer="under" class="size-3.5">
			<Inline as="span" gap="none" justify="center" fill>
				{#if indeterminate}
					<Icon icon="lucide:minus" class="size-4" />
				{:else}
					<Icon icon="lucide:check" class={cn('size-4', !checked && 'text-transparent')} />
				{/if}
			</Inline>
		</Imposter>
		{@render childrenProp?.()}
	{/snippet}
</MenubarPrimitive.CheckboxItem>
