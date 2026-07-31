<script lang="ts">
	import { cn } from '#lib/utils';
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DrawerPrimitive.TitleProps = $props();
</script>

<DrawerPrimitive.Title bind:ref class={cn('text-heading', className)} {...restProps} />
