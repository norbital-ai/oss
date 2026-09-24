<script lang="ts">
	import { Inline } from '#lib/layout';
	import { cn } from '#lib/utils';
	import { NavigationMenu as NavigationMenuPrimitive } from 'bits-ui';
	import NavigationMenuViewport from './navigation-menu-viewport.svelte';

	let {
		ref = $bindable(null),
		class: className,
		viewport = true,
		viewportWrapperClass,
		children,
		...restProps
	}: NavigationMenuPrimitive.RootProps & {
		viewport?: boolean;
		viewportWrapperClass?: string;
	} = $props();
</script>

<NavigationMenuPrimitive.Root
	bind:ref
	data-slot="navigation-menu"
	data-viewport={viewport}
	class={cn('group/navigation-menu relative max-w-max', className)}
	{...restProps}
>
	{#snippet child({ props })}
		<Inline gap="none" justify="center" grow {...props}>
			{@render children?.()}
			{#if viewport}
				<NavigationMenuViewport wrapperClass={viewportWrapperClass} />
			{/if}
		</Inline>
	{/snippet}
</NavigationMenuPrimitive.Root>
