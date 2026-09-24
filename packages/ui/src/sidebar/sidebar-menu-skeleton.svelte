<script lang="ts">
	import { Inline } from '#lib/layout';
	import { cn, type WithElementRef } from '#lib/utils';
	import { Skeleton } from '#lib/skeleton';
	import type { HTMLAttributes } from 'svelte/elements';

	let {
		ref = $bindable(null),
		class: className,
		showIcon = false,
		children,
		...restProps
	}: WithElementRef<HTMLAttributes<HTMLElement>> & {
		showIcon?: boolean;
	} = $props();

	// Random width between 50% and 90%
	const width = `${Math.floor(Math.random() * 40) + 50}%`;
</script>

<Inline
	gap="sm"
	data-slot="sidebar-menu-skeleton"
	data-sidebar="menu-skeleton"
	class={cn('h-8 rounded-md px-2', className)}
	{...restProps}
	{@attach (node: HTMLElement) => {
		ref = node;
		return () => (ref = null);
	}}
>
	{#if showIcon}
		<Skeleton class="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />
	{/if}
	<Skeleton
		class="h-4 max-w-(--skeleton-width) flex-1"
		data-sidebar="menu-skeleton-text"
		style="--skeleton-width: {width};"
	/>
	{@render children?.()}
</Inline>
