<script lang="ts">
	import { Collapsible as CollapsiblePrimitive, type WithoutChild } from 'bits-ui';

	let {
		ref = $bindable(null),
		children,
		...restProps
	}: WithoutChild<CollapsiblePrimitive.TriggerProps> = $props();
</script>

<CollapsiblePrimitive.Trigger bind:ref data-slot="collapsible-trigger" {...restProps}>
	{@render children?.()}
</CollapsiblePrimitive.Trigger>
