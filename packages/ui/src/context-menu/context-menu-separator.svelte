<script lang="ts">
	import { cn } from '#lib/utils';
	import { ContextMenu as ContextMenuPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: ContextMenuPrimitive.SeparatorProps = $props();
</script>

<ContextMenuPrimitive.Separator
	bind:ref
	class={cn('-mx-1 my-1 h-px bg-border', className)}
	{...restProps}
/>
