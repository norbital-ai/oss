<script lang="ts">
	import { cn } from '#lib/utils';
	import { Collapsible as CollapsiblePrimitive, type WithoutChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithoutChild<CollapsiblePrimitive.TriggerProps> = $props();
</script>

<CollapsiblePrimitive.Trigger
	bind:ref
	data-slot="collapsible-trigger"
	class={cn(className)}
	{...restProps}
>
	{@render children?.()}
</CollapsiblePrimitive.Trigger>
