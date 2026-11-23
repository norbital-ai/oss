<!--
@component
A form label.
-->
<script lang="ts">
	import type { HTMLLabelAttributes } from 'svelte/elements';
	import { cn, type WithElementRef } from '../utils.js';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLLabelAttributes, HTMLLabelElement> = $props();
</script>

<label
	bind:this={ref}
	class={cn('text-label peer-disabled:cursor-not-allowed peer-disabled:opacity-70', className)}
	{...restProps}
>
	{@render children?.()}
</label>
