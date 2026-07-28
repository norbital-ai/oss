<script lang="ts">
	import { cn } from '#lib/utils';
	import { Menubar as MenubarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: MenubarPrimitive.SubContentProps = $props();
</script>

<MenubarPrimitive.SubContent
	bind:ref
	class={cn(
		'z-50 min-w-max rounded-md border bg-popover p-1 text-popover-foreground focus:outline-none',
		className
	)}
	{...restProps}
/>
