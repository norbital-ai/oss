<script lang="ts">
	import Icon from '@iconify/svelte';
	import { Menubar as MenubarPrimitive, type WithoutChildrenOrChild } from 'bits-ui';

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
		'relative flex cursor-default items-center rounded-sm py-1.5 pr-2 pl-8 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children({ checked, indeterminate })}
		<span class="absolute left-2 flex size-3.5 items-center justify-center">
			{#if indeterminate}
				<Icon icon="lucide:minus" class="size-4" />
			{:else}
				<Icon icon="lucide:check" class={cn('size-4', !checked && 'text-transparent')} />
			{/if}
		</span>
		{@render childrenProp?.()}
	{/snippet}
</MenubarPrimitive.CheckboxItem>
