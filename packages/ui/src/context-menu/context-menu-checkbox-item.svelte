<script lang="ts">
	import { cn } from '#lib/utils';
	import { ContextMenu as ContextMenuPrimitive, type WithoutChild } from 'bits-ui';
	import Checkbox from '../checkbox/checkbox.svelte';

	let {
		ref = $bindable(null),
		checked = $bindable(false),
		indeterminate = $bindable(false),
		class: className,
		children: childrenProp,
		...restProps
	}: WithoutChild<ContextMenuPrimitive.CheckboxItemProps> = $props();
</script>

<ContextMenuPrimitive.CheckboxItem
	bind:ref
	bind:checked
	class={cn(
		'relative flex cursor-default items-center gap-6 rounded-sm px-3 py-1.5 pr-2 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground',
		className
	)}
	{...restProps}
>
	{#snippet children()}
		<Checkbox {checked} {indeterminate} />
		{@render childrenProp?.({ checked, indeterminate })}
	{/snippet}
</ContextMenuPrimitive.CheckboxItem>
