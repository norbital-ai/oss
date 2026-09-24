<script lang="ts">
	import { cn } from '#lib/utils';
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';

	let {
		ref = $bindable(null),
		class: className,
		...restProps
	}: DrawerPrimitive.OverlayProps = $props();
</script>

<DrawerPrimitive.Overlay
	bind:ref
	class={cn(
		// repository-health:allow UI19 -- vaul owns the overlay element (presence and drag-linked fade); Imposter's `as` renders plain tags, not a vaul component, so the fixed inset-0 z-50 scrim stays on the library's element
		'fixed inset-0 z-50 bg-black/80',
		className
	)}
	{...restProps}
/>
