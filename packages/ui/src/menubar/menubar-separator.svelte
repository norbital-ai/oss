<script lang="ts">
	import { cn } from '#lib/utils';
	import { Menubar as MenubarPrimitive } from 'bits-ui';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: MenubarPrimitive.SeparatorProps = $props();
</script>

<MenubarPrimitive.Separator
	bind:ref
	class={cn('-mx-1 my-1 h-px bg-muted', className)}
	{...restProps}
/>
