<script lang="ts">
	import { cn } from '#lib/utils';
	import { ContextMenu as ContextMenuPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: ContextMenuPrimitive.ContentProps = $props();
</script>

<ContextMenuPrimitive.Portal>
	<ContextMenuPrimitive.Content
		bind:ref
		class={cn(
			'z-[2000] min-w-[8rem] rounded-md border bg-popover p-1 text-popover-foreground shadow-md focus:outline-none',
			className
		)}
		{...restProps}
	/>
</ContextMenuPrimitive.Portal>
