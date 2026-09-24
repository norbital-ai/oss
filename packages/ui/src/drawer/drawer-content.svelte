<script lang="ts">
	import { resetInset } from '#lib/layout/inset.svelte';
	import { cn } from '#lib/utils';
	import { Drawer as DrawerPrimitive } from 'vaul-svelte';
	import DrawerOverlay from './drawer-overlay.svelte';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: DrawerPrimitive.ContentProps = $props();
	// An overlay is a new page edge: it does not inherit the page's inset owner.
	resetInset(false);
</script>

<DrawerPrimitive.Portal>
	<DrawerOverlay />
	<DrawerPrimitive.Content
		bind:ref
		class={cn(
			// repository-health:allow UI19 -- vaul owns the drawer element and drives its drag transform; Imposter's `as` renders plain tags, not a vaul component, so its viewport-bottom pin stays on the library's element
			// repository-health:allow UI6 -- the drawer box is vaul's element; its column of handle + body is the element's own flex, which a nested primitive would move off the drag target
			// repository-health:allow UI27 -- the column direction of the same vaul element (see UI6 above)
			'fixed inset-x-0 bottom-0 z-50 mt-24 flex h-auto flex-col rounded-t-[10px] border bg-popover pt-4',
			className
		)}
		{...restProps}
	>
		<div class="mx-auto h-2 w-25 rounded-full bg-muted"></div>
		{@render children?.()}
	</DrawerPrimitive.Content>
</DrawerPrimitive.Portal>
