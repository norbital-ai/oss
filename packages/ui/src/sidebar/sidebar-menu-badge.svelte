<script lang="ts">
	import { Imposter, Inline } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> = $props();
</script>

<!-- A sibling of the menu button: the peer variants pick its top offset from the button's size. -->
<Imposter
	bind:ref
	placement="top-end"
	offset="xs"
	layer="under"
	data-slot="sidebar-menu-badge"
	data-sidebar="menu-badge"
	class={cn(
		'pointer-events-none h-5 min-w-5 rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none',
		'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
		'peer-data-[size=sm]/menu-button:top-1',
		'peer-data-[size=default]/menu-button:top-1.5',
		'peer-data-[size=lg]/menu-button:top-2.5',
		'group-data-[collapsible=icon]:hidden',
		className
	)}
	{...restProps as HTMLAttributes<HTMLDivElement>}
>
	<Inline gap="none" justify="center" fill>
		{@render children?.()}
	</Inline>
</Imposter>
