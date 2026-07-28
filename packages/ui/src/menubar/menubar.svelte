<script lang="ts">
	import { cn } from '#lib/utils';
	import { Menubar as MenubarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: MenubarPrimitive.RootProps = $props();
</script>

<MenubarPrimitive.Root
	bind:ref
	class={cn('flex h-8 items-center space-x-1 rounded-md border bg-background p-1', className)}
	{...restProps}
/>
