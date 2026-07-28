<script lang="ts">
	import { type ToggleVariants, toggleVariants } from '#lib/toggle';
	import { cn } from '#lib/utils';
	import { ToggleGroup as ToggleGroupPrimitive } from 'bits-ui';
	import { getToggleGroupCtx } from './toggle-group.svelte';

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		size,
		variant,
		...restProps
	}: ToggleGroupPrimitive.ItemProps & ToggleVariants = $props();

	// Get the getter, then derive to maintain reactivity
	const ctxGetter = getToggleGroupCtx();
	const ctx = $derived(ctxGetter());
</script>

<ToggleGroupPrimitive.Item
	bind:ref
	class={cn(
		toggleVariants({
			variant: ctx().variant || variant,
			size: ctx().size || size
		}),
		className
	)}
	{value}
	{...restProps}
/>
